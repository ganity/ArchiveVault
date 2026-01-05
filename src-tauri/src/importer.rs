use crate::db;
use crate::docx;
use crate::library_root::{resolve_library_root, LibraryRootState};
use crate::progress;
use crate::search;
use anyhow::{anyhow, Context, Result};
use chrono::{Datelike, FixedOffset, NaiveDate, TimeZone};
use encoding_rs::GBK;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Seek};
use std::path::Path;
use tauri::State;
use uuid::Uuid;
use zip::ZipArchive;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportResult {
    pub imported: usize,
    pub skipped: usize,
    pub failed: usize,
    pub archives: Vec<db::ArchiveRow>,
}

fn tz_offset() -> FixedOffset {
    FixedOffset::east_opt(8 * 3600).expect("tz")
}

fn now_ts() -> i64 {
    chrono::Utc::now().timestamp()
}

#[tauri::command]
pub fn pick_zip_files() -> Result<Vec<String>, String> {
    let files = rfd::FileDialog::new()
        .add_filter("ZIP", &["zip"])
        .pick_files()
        .unwrap_or_default();
    Ok(files
        .into_iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect())
}

#[tauri::command]
pub fn pick_zip_folder_files() -> Result<Vec<String>, String> {
    let folder = rfd::FileDialog::new().pick_folder();
    let Some(folder) = folder else {
        return Ok(vec![]);
    };
    let mut out = Vec::new();
    if let Err(e) = collect_zip_files(&folder, &mut out, 2000) {
        return Err(format!("{e:#}"));
    }
    Ok(out)
}

fn collect_zip_files(dir: &Path, out: &mut Vec<String>, limit: usize) -> Result<()> {
    if out.len() >= limit {
        return Ok(());
    }
    for entry in fs::read_dir(dir).with_context(|| format!("读取目录失败: {}", dir.display()))? {
        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') {
            continue;
        }
        let ty = entry.file_type()?;
        if ty.is_dir() {
            collect_zip_files(&path, out, limit)?;
        } else if ty.is_file() {
            let lower = name.to_ascii_lowercase();
            if lower.ends_with(".zip") {
                out.push(path.to_string_lossy().to_string());
                if out.len() >= limit {
                    break;
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn import_zips(
    app: tauri::AppHandle,
    state: State<'_, LibraryRootState>,
    paths: Vec<String>,
) -> Result<ImportResult, String> {
    // 导入是重CPU/IO的同步任务：放到阻塞线程池，避免卡住主线程导致 UI 无响应/Windows 崩溃
    let root = resolve_library_root(&app, &state).map_err(db::err_to_string)?;
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || import_zips_impl(&app2, &root, paths))
        .await
        .map_err(|e| db::err_to_string(anyhow!(e).context("导入线程失败")))?
        .map_err(db::err_to_string)
}

const IMPORT_STEPS_PER_ZIP: usize = 6;

fn emit_import_progress(
    app: &tauri::AppHandle,
    zip_idx: usize,
    zip_total: usize,
    local_step: usize,
    step: &str,
    message: &str,
) {
    // 让前端进度条在整个“批量导入”期间持续可见
    let total = zip_total.saturating_mul(IMPORT_STEPS_PER_ZIP).max(1);
    let current = zip_idx
        .saturating_mul(IMPORT_STEPS_PER_ZIP)
        .saturating_add(local_step.min(IMPORT_STEPS_PER_ZIP.saturating_sub(1)));
    progress::emit(app, progress::ProgressEvent::new("import", current, total, step, message));
}

fn import_zips_impl(
    app: &tauri::AppHandle,
    root: &Path,
    paths: Vec<String>,
) -> Result<ImportResult> {
    db::init_db(app, root)?;
    let mut conn = Connection::open(root.join("db.sqlite"))?;

    let mut imported = 0usize;
    let mut skipped = 0usize;
    let mut failed = 0usize;
    let mut archives = Vec::new();

    let total = paths.len();
    progress::emit(app, progress::ProgressEvent::new("import", 0, total.max(1), "开始", "准备导入ZIP"));

    for (idx, p) in paths.into_iter().enumerate() {
        emit_import_progress(app, idx, total, 0, "处理ZIP", &format!("正在处理: {}", p));
        match import_one_zip(app, &mut conn, root, Path::new(&p), idx, total) {
            Ok(row) => {
                imported += 1;
                archives.push(row);
            }
            Err(e) => {
                // 若是重复跳过
                if e.to_string().contains("__SKIP__") {
                    skipped += 1;
                    emit_import_progress(app, idx, total, IMPORT_STEPS_PER_ZIP - 1, "跳过", "指纹已存在，跳过该ZIP");
                    continue;
                }
                failed += 1;
                emit_import_progress(app, idx, total, IMPORT_STEPS_PER_ZIP - 1, "失败", "导入失败（已记录错误）");
                eprintln!("导入失败: {p}: {e:#}");
            }
        }
    }

    // 用同一口径的 total/current 标记完成，保证前端进度条能走满
    let total_steps = total.saturating_mul(IMPORT_STEPS_PER_ZIP).max(1);
    progress::emit(
        app,
        progress::ProgressEvent::new(
            "import",
            total_steps,
            total_steps,
            "完成",
            &format!("导入完成：导入{imported} 跳过{skipped} 失败{failed}"),
        ),
    );

    Ok(ImportResult {
        imported,
        skipped,
        failed,
        archives,
    })
}

#[tauri::command]
pub fn reparse_main_doc(
    app: tauri::AppHandle,
    state: State<'_, LibraryRootState>,
    archive_id: String,
) -> Result<String, String> {
    reparse_main_doc_impl(&app, &state, &archive_id).map_err(db::err_to_string)
}

fn reparse_main_doc_impl(
    app: &tauri::AppHandle,
    state: &LibraryRootState,
    archive_id: &str,
) -> Result<String> {
    let root = resolve_library_root(app, state)?;
    db::init_db(app, &root)?;
    let mut conn = Connection::open(root.join("db.sqlite"))?;

    let (original_name, stored_path): (String, String) = conn
        .query_row(
            "SELECT original_name, stored_path FROM archives WHERE archive_id=?",
            [archive_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .with_context(|| format!("找不到档案: {}", archive_id))?;

    let stored_abs = root.join(&stored_path);
    if !stored_abs.exists() {
        return Err(anyhow!("ZIP不存在: {}", stored_abs.display()));
    }

    progress::emit(
        app,
        progress::ProgressEvent::new("reparse", 0, 3, "扫描ZIP", "识别主docx"),
    );
    let mut zip = ZipArchive::new(fs::File::open(&stored_abs)?)?;
    let main_docx_name = identify_main_docx(&original_name, &mut zip)?;
    let main_docx_bytes = read_zip_entry_bytes(&mut zip, &main_docx_name)
        .with_context(|| format!("读取主docx失败: {main_docx_name}"))?;

    progress::emit(
        app,
        progress::ProgressEvent::new("reparse", 1, 3, "解析主docx", "抽取字段与段落"),
    );
    let parsed = docx::parse_main_docx(&main_docx_bytes)?;

    progress::emit(
        app,
        progress::ProgressEvent::new("reparse", 2, 3, "写入数据库", "更新主文与索引"),
    );
    let tx = conn.transaction()?;

    // main_doc upsert
    let changed = tx.execute(
        "UPDATE main_doc SET instruction_no=?, title=?, issued_at=?, content=?, field_block_map_json=? WHERE archive_id=?",
        params![
            parsed.instruction_no,
            parsed.title,
            parsed.issued_at,
            parsed.content,
            parsed.field_block_map_json,
            archive_id
        ],
    )?;
    if changed == 0 {
        tx.execute(
            "INSERT INTO main_doc(archive_id,instruction_no,title,issued_at,content,field_block_map_json) VALUES(?,?,?,?,?,?)",
            params![
                archive_id,
                parsed.instruction_no,
                parsed.title,
                parsed.issued_at,
                parsed.content,
                parsed.field_block_map_json
            ],
        )?;
    }

    // 重建 blocks 与 FTS（避免旧数据污染）
    tx.execute("DELETE FROM docx_blocks WHERE archive_id=?", [archive_id])?;
    tx.execute("DELETE FROM docx_blocks_fts WHERE archive_id=?", [archive_id])?;
    tx.execute("DELETE FROM main_doc_fts WHERE archive_id=?", [archive_id])?;

    {
        let mut stmt = tx.prepare("INSERT INTO docx_blocks(archive_id,block_id,text) VALUES(?,?,?)")?;
        for b in &parsed.blocks {
            stmt.execute(params![archive_id, b.block_id, b.text])?;
        }
    }
    {
        let mut stmt = tx.prepare(
            "INSERT INTO docx_blocks_fts(archive_id,block_id,search_text,source_text) VALUES(?,?,?,?)",
        )?;
        for b in &parsed.blocks {
            let search_text = search::build_search_text(&b.text);
            stmt.execute(params![archive_id, b.block_id, search_text, b.text])?;
        }
    }
    {
        let mut stmt = tx.prepare(
            "INSERT INTO main_doc_fts(archive_id,field_name,search_text,source_text) VALUES(?,?,?,?)",
        )?;
        let fields = [
            ("instruction_no", parsed.instruction_no.as_str()),
            ("title", parsed.title.as_str()),
            ("issued_at", parsed.issued_at.as_str()),
            ("content", parsed.content.as_str()),
        ];
        for (name, text) in fields {
            let search_text = search::build_search_text(text);
            stmt.execute(params![archive_id, name, search_text, text])?;
        }
    }

    tx.execute(
        "UPDATE archives SET status='completed', error=NULL WHERE archive_id=?",
        [archive_id],
    )?;
    tx.commit()?;

    progress::emit(app, progress::ProgressEvent::complete("reparse", "重新解析完成"));
    Ok("重新解析完成".to_string())
}

fn sha256_file(path: &Path) -> Result<String> {
    let mut f = fs::File::open(path).with_context(|| format!("打开ZIP失败: {}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 1024 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn parse_zip_date_from_name(name: &str, imported_at: i64) -> i64 {
    // 仅支持常见 YYYYMMDD 或 YYYY-MM-DD
    let try_parse = |s: &str| -> Option<NaiveDate> {
        if s.len() == 8 && s.chars().all(|c| c.is_ascii_digit()) {
            let y = s[0..4].parse::<i32>().ok()?;
            let m = s[4..6].parse::<u32>().ok()?;
            let d = s[6..8].parse::<u32>().ok()?;
            return NaiveDate::from_ymd_opt(y, m, d);
        }
        if s.len() == 10
            && s.chars().nth(4) == Some('-')
            && s.chars().nth(7) == Some('-')
        {
            let y = s[0..4].parse::<i32>().ok()?;
            let m = s[5..7].parse::<u32>().ok()?;
            let d = s[8..10].parse::<u32>().ok()?;
            return NaiveDate::from_ymd_opt(y, m, d);
        }
        None
    };

    let stem = Path::new(name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(name);
    let candidates: Vec<&str> = stem
        .split(|c: char| !c.is_ascii_digit() && c != '-')
        .filter(|s| !s.is_empty())
        .collect();
    for c in candidates {
        if let Some(d) = try_parse(c) {
            let dt = tz_offset()
                .from_local_datetime(&d.and_hms_opt(0, 0, 0).unwrap())
                .single()
                .unwrap();
            return dt.timestamp();
        }
    }

    // 回退：用 imported_at 截断到东八区当天 00:00
    let dt = tz_offset().timestamp_opt(imported_at, 0).single().unwrap();
    let d = NaiveDate::from_ymd_opt(dt.year(), dt.month(), dt.day()).unwrap();
    tz_offset()
        .from_local_datetime(&d.and_hms_opt(0, 0, 0).unwrap())
        .single()
        .unwrap()
        .timestamp()
}

fn import_one_zip(
    app: &tauri::AppHandle,
    conn: &mut Connection,
    root: &Path,
    source_path: &Path,
    zip_idx: usize,
    zip_total: usize,
) -> Result<db::ArchiveRow> {
    let original_name = source_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("UNKNOWN.zip")
        .to_string();
    let imported_at = now_ts();
    let zip_date = parse_zip_date_from_name(&original_name, imported_at);

    emit_import_progress(app, zip_idx, zip_total, 1, "计算指纹", &original_name);
    let sha256 = sha256_file(source_path)?;
    let exists: Option<String> = conn
        .query_row(
            "SELECT archive_id FROM archives WHERE sha256=?",
            [sha256.as_str()],
            |r| r.get(0),
        )
        .optional()?;
    if exists.is_some() {
        return Err(anyhow!("__SKIP__ 已存在"));
    }

    let archive_id = Uuid::new_v4().to_string();
    let stored_rel = format!("store/{archive_id}/{original_name}");
    let stored_abs = root.join(&stored_rel);

    let run = (|| -> Result<db::ArchiveRow> {
        emit_import_progress(app, zip_idx, zip_total, 2, "复制ZIP", &stored_rel);
        fs::create_dir_all(stored_abs.parent().unwrap())?;
        fs::copy(source_path, &stored_abs)?;

        // 先写入 archives（processing）
        emit_import_progress(app, zip_idx, zip_total, 2, "写入数据库", "archives");
        conn.execute(
            "INSERT INTO archives(archive_id,sha256,original_name,source_path,stored_path,zip_date,imported_at,status,error)
             VALUES(?,?,?,?,?,?,?,?,NULL)",
            params![
                archive_id,
                sha256,
                original_name,
                source_path.to_string_lossy().to_string(),
                stored_rel,
                zip_date,
                imported_at,
                "processing"
            ],
        )?;

        emit_import_progress(app, zip_idx, zip_total, 3, "扫描ZIP", "识别主docx");
        let mut zip = ZipArchive::new(fs::File::open(&stored_abs)?)?;
        let main_docx_name = identify_main_docx(&original_name, &mut zip)?;
        let main_docx_bytes = read_zip_entry_bytes(&mut zip, &main_docx_name)
            .with_context(|| format!("读取主docx失败: {main_docx_name}"))?;

        emit_import_progress(app, zip_idx, zip_total, 4, "解析主docx", "抽取字段与段落");
        let parsed = docx::parse_main_docx(&main_docx_bytes)?;

        // 写 main_doc + blocks + FTS + attachments 采用一个事务，避免中途失败留下半数据
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO main_doc(archive_id,instruction_no,title,issued_at,content,field_block_map_json)
             VALUES(?,?,?,?,?,?)",
            params![
                archive_id,
                parsed.instruction_no,
                parsed.title,
                parsed.issued_at,
                parsed.content,
                parsed.field_block_map_json
            ],
        )?;
        {
            let mut stmt =
                tx.prepare("INSERT INTO docx_blocks(archive_id,block_id,text) VALUES(?,?,?)")?;
            for b in &parsed.blocks {
                stmt.execute(params![archive_id, b.block_id, b.text])?;
            }
        }
        {
            let mut stmt = tx.prepare(
                "INSERT INTO docx_blocks_fts(archive_id,block_id,search_text,source_text) VALUES(?,?,?,?)",
            )?;
            for b in &parsed.blocks {
                let search_text = search::build_search_text(&b.text);
                stmt.execute(params![archive_id, b.block_id, search_text, b.text])?;
            }
        }
        {
            let mut stmt = tx.prepare(
                "INSERT INTO main_doc_fts(archive_id,field_name,search_text,source_text) VALUES(?,?,?,?)",
            )?;
            let fields = [
                ("instruction_no", parsed.instruction_no.as_str()),
                ("title", parsed.title.as_str()),
                ("issued_at", parsed.issued_at.as_str()),
                ("content", parsed.content.as_str()),
            ];
            for (name, text) in fields {
                let search_text = search::build_search_text(text);
                stmt.execute(params![archive_id, name, search_text, text])?;
            }
        }

        // 附件枚举（主 ZIP + 一层子 ZIP）
        emit_import_progress(app, zip_idx, zip_total, 5, "枚举附件", "主ZIP/子ZIP");
        let attachments = enumerate_attachments(&stored_abs, &main_docx_name)?;
        write_attachments_tx(&tx, &archive_id, attachments)?;

        tx.execute(
            "UPDATE archives SET status='completed' WHERE archive_id=?",
            [archive_id.as_str()],
        )?;
        tx.commit()?;

        emit_import_progress(app, zip_idx, zip_total, 5, "完成", &original_name);
        Ok(db::ArchiveRow {
            archive_id: archive_id.clone(),
            original_name: original_name.clone(),
            stored_path: stored_rel.clone(),
            zip_date,
            imported_at,
            status: "completed".to_string(),
            error: None,
        })
    })();

    match run {
        Ok(v) => Ok(v),
        Err(e) => {
            let msg = format!("{e:#}");
            let _ = conn.execute(
                "UPDATE archives SET status='failed', error=? WHERE archive_id=?",
                params![msg, archive_id],
            );
            Err(e)
        }
    }
}

fn identify_main_docx<R: Read + Seek>(zip_filename: &str, zip: &mut ZipArchive<R>) -> Result<String> {
    let mut docx_entries = Vec::new(); // (internal_name, decoded_name)
    for i in 0..zip.len() {
        let f = zip.by_index(i)?;
        let internal = f.name().to_string();
        let decoded = decode_zip_filename(f.name_raw(), &internal);
        if decoded.to_ascii_lowercase().ends_with(".docx") {
            docx_entries.push((internal, decoded));
        }
    }
    if docx_entries.is_empty() {
        return Err(anyhow!("ZIP内未找到docx"));
    }

    let zip_stem = Path::new(zip_filename)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();

    // 精确匹配（用 decoded_name）
    for (internal, decoded) in &docx_entries {
        let stem = Path::new(decoded)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase();
        if stem == zip_stem {
            return Ok(internal.clone());
        }
    }
    // 包含匹配
    for (internal, decoded) in &docx_entries {
        let stem = Path::new(decoded)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase();
        if zip_stem.contains(&stem) || stem.contains(&zip_stem) {
            return Ok(internal.clone());
        }
    }
    Ok(docx_entries[0].0.clone())
}

fn read_zip_entry_bytes<R: Read + Seek>(zip: &mut ZipArchive<R>, entry_name: &str) -> Result<Vec<u8>> {
    // by_name 可能失败，增加扫描兜底
    if let Ok(mut f) = zip.by_name(entry_name) {
        let mut buf = Vec::new();
        f.read_to_end(&mut buf)?;
        return Ok(buf);
    }
    for i in 0..zip.len() {
        let mut f = zip.by_index(i)?;
        if f.name() == entry_name {
            let mut buf = Vec::new();
            f.read_to_end(&mut buf)?;
            return Ok(buf);
        }
    }
    Err(anyhow!("ZIP内找不到条目: {entry_name}"))
}

#[derive(Debug, Clone)]
struct AttachmentToInsert {
    file_id: String,
    display_name: String,
    file_type: String,
    source_depth: i64,
    container_virtual_path: Option<String>,
    virtual_path: String,
    size_bytes: Option<i64>,
}

fn file_type_from_name(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".pdf") {
        return "pdf".to_string();
    }
    if lower.ends_with(".xlsx") || lower.ends_with(".xls") {
        return "excel".to_string();
    }
    if lower.ends_with(".png")
        || lower.ends_with(".jpg")
        || lower.ends_with(".jpeg")
        || lower.ends_with(".gif")
        || lower.ends_with(".bmp")
    {
        return "image".to_string();
    }
    if lower.ends_with(".mp4") || lower.ends_with(".mov") || lower.ends_with(".avi") || lower.ends_with(".wmv") {
        return "video".to_string();
    }
    if lower.ends_with(".docx") {
        return "docx_other".to_string();
    }
    if lower.ends_with(".zip") {
        return "zip_child".to_string();
    }
    "other".to_string()
}

fn basename(path: &str) -> String {
    let p = path.replace('\\', "/");
    p.split('/').last().unwrap_or(&p).to_string()
}

fn stable_file_id(archive_id: &str, source_depth: i64, container_virtual_path: &Option<String>, virtual_path: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(archive_id.as_bytes());
    hasher.update(b"|");
    hasher.update(source_depth.to_string().as_bytes());
    hasher.update(b"|");
    if let Some(c) = container_virtual_path {
        hasher.update(c.as_bytes());
    }
    hasher.update(b"|");
    hasher.update(virtual_path.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn enumerate_attachments(zip_abs: &Path, main_docx_name: &str) -> Result<Vec<AttachmentToInsert>> {
    let mut out = Vec::new();
    let mut zip = ZipArchive::new(fs::File::open(zip_abs)?)?;

    // 先枚举主 ZIP
    let mut child_zips = Vec::new(); // (internal_virtual_path, decoded_basename, size)
    for i in 0..zip.len() {
        let f = zip.by_index(i)?;
        let internal = f.name().to_string();
        if internal.ends_with('/') {
            continue;
        }
        let decoded = decode_zip_filename(f.name_raw(), &internal);
        let lower = decoded.to_ascii_lowercase();
        if should_skip_zip_entry(&decoded, &internal) {
            continue;
        }
        if lower.ends_with(".ds_store") {
            continue;
        }
        if lower.ends_with(".docx") && internal == main_docx_name {
            continue;
        }
        let display_name = basename(&decoded);
        let ty = file_type_from_name(&decoded);
        if ty == "zip_child" {
            child_zips.push((internal.clone(), display_name.clone(), f.size() as i64));
        }

        // 记录主ZIP附件（包括子zip本体）
        let container_virtual_path = None;
        let file_id = stable_file_id("__ARCHIVE_ID__", 0, &container_virtual_path, &internal); // 占位，后面修复
        out.push(AttachmentToInsert {
            file_id,
            display_name,
            file_type: ty,
            source_depth: 0,
            container_virtual_path,
            virtual_path: internal,
            size_bytes: Some(f.size() as i64),
        });
    }

    // 展开子 ZIP（一层）
    for (child_internal_path, child_display, _sz) in child_zips {
        let child_bytes = read_zip_entry_bytes(&mut zip, &child_internal_path)?;
        let mut nested = ZipArchive::new(std::io::Cursor::new(child_bytes))?;
        for i in 0..nested.len() {
            let f = nested.by_index(i)?;
            let internal = f.name().to_string();
            if internal.ends_with('/') {
                continue;
            }
            let decoded = decode_zip_filename(f.name_raw(), &internal);
            if should_skip_zip_entry(&decoded, &internal) {
                continue;
            }
            let file_basename = basename(&decoded);
            let display_name = format!("[{}]/{}", child_display, file_basename);
            let ty = file_type_from_name(&decoded);
            if ty == "zip_child" {
                // 深度限制为2，子zip内的zip不展开，但可作为普通附件名记录
            }
            let container_virtual_path = Some(child_internal_path.clone());
            let file_id = stable_file_id("__ARCHIVE_ID__", 1, &container_virtual_path, &internal); // 占位，后面修复
            out.push(AttachmentToInsert {
                file_id,
                display_name,
                file_type: ty,
                source_depth: 1,
                container_virtual_path,
                virtual_path: internal,
                size_bytes: Some(f.size() as i64),
            });
        }
    }

    Ok(out)
}

fn should_skip_zip_entry(decoded: &str, internal: &str) -> bool {
    let d = decoded.replace('\\', "/").to_ascii_lowercase();
    let i = internal.replace('\\', "/").to_ascii_lowercase();
    if d.starts_with("__macosx/") || i.starts_with("__macosx/") {
        return true;
    }
    let base = basename(decoded).to_ascii_lowercase();
    if base.starts_with("._") {
        // macOS AppleDouble 资源分叉文件（不是实际内容）
        return true;
    }
    false
}

fn decode_zip_filename(raw: &[u8], fallback: &str) -> String {
    // 先尝试utf8
    if let Ok(s) = std::str::from_utf8(raw) {
        if !s.chars().any(|c| c == '\u{FFFD}' || c == '□') {
            return s.to_string();
        }
    }
    let (decoded, _, had_errors) = GBK.decode(raw);
    if !had_errors {
        return decoded.to_string();
    }
    // 最后兜底：用zip crate给出的name()
    fallback.to_string()
}

fn write_attachments_tx(
    tx: &rusqlite::Transaction<'_>,
    archive_id: &str,
    mut attachments: Vec<AttachmentToInsert>,
) -> Result<()> {
    // 修复占位 file_id（需要 archive_id）
    for a in attachments.iter_mut() {
        a.file_id = stable_file_id(archive_id, a.source_depth, &a.container_virtual_path, &a.virtual_path);
    }

    {
        let mut stmt = tx.prepare(
            "INSERT INTO attachments(file_id,archive_id,display_name,file_type,source_depth,container_virtual_path,virtual_path,cached_path,size_bytes)
             VALUES(?,?,?,?,?,?,?,?,?)",
        )?;
        let mut stmt_fts = tx.prepare(
            "INSERT INTO attachments_fts(archive_id,file_id,search_text,display_name) VALUES(?,?,?,?)",
        )?;
        for a in &attachments {
            stmt.execute(params![
                a.file_id,
                archive_id,
                a.display_name,
                a.file_type,
                a.source_depth,
                a.container_virtual_path,
                a.virtual_path,
                Option::<String>::None,
                a.size_bytes
            ])?;
            let search_text = search::build_search_text(&a.display_name);
            stmt_fts.execute(params![archive_id, a.file_id, search_text, a.display_name])?;
        }
    }
    Ok(())
}
