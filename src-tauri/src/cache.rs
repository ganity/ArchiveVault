use crate::db;
use crate::library_root::{resolve_library_root, LibraryRootState};
use crate::progress;
use anyhow::{anyhow, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Seek};
use std::path::Path;
use tauri::State;
use zip::ZipArchive;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreviewPathResp {
    pub file_id: String,
    pub path: String,
}

#[tauri::command]
pub fn cleanup_cache(app: tauri::AppHandle, state: State<'_, LibraryRootState>) -> Result<String, String> {
    progress::emit(&app, progress::ProgressEvent::new("cleanup_cache", 0, 2, "开始", "准备清理缓存"));
    let r = cleanup_cache_impl(&app, &state).map_err(db::err_to_string)?;
    progress::emit(&app, progress::ProgressEvent::complete("cleanup_cache", "清理缓存完成"));
    Ok(r)
}

fn cleanup_cache_impl(app: &tauri::AppHandle, state: &LibraryRootState) -> Result<String> {
    let root = resolve_library_root(app, state)?;
    db::init_db(app, &root)?;
    let conn = Connection::open(root.join("db.sqlite"))?;
    // 清除DB中的 cached_path
    conn.execute("UPDATE attachments SET cached_path=NULL", [])?;
    // 删除缓存目录
    let cache_dir = root.join("cache");
    if cache_dir.exists() {
        fs::remove_dir_all(&cache_dir).context("删除cache目录失败")?;
    }
    fs::create_dir_all(&cache_dir).context("重建cache目录失败")?;
    Ok("已清理全部缓存".to_string())
}

#[tauri::command]
pub fn cleanup_archive_cache(
    app: tauri::AppHandle,
    state: State<'_, LibraryRootState>,
    archive_id: String,
) -> Result<String, String> {
    progress::emit(&app, progress::ProgressEvent::new("cleanup_archive_cache", 0, 2, "开始", "准备清理档案缓存"));
    let r = cleanup_archive_cache_impl(&app, &state, &archive_id).map_err(db::err_to_string)?;
    progress::emit(&app, progress::ProgressEvent::complete("cleanup_archive_cache", "清理档案缓存完成"));
    Ok(r)
}

fn cleanup_archive_cache_impl(
    app: &tauri::AppHandle,
    state: &LibraryRootState,
    archive_id: &str,
) -> Result<String> {
    let root = resolve_library_root(app, state)?;
    db::init_db(app, &root)?;
    let conn = Connection::open(root.join("db.sqlite"))?;
    conn.execute(
        "UPDATE attachments SET cached_path=NULL WHERE archive_id=?",
        params![archive_id],
    )?;
    let dir = root.join("cache").join(archive_id);
    if dir.exists() {
        fs::remove_dir_all(&dir).context("删除档案缓存目录失败")?;
    }
    Ok("已清理该档案缓存".to_string())
}

#[tauri::command]
pub fn get_attachment_preview_path(
    app: tauri::AppHandle,
    state: State<'_, LibraryRootState>,
    file_id: String,
) -> Result<PreviewPathResp, String> {
    get_attachment_preview_path_impl(&app, &state, &file_id).map_err(db::err_to_string)
}

pub(crate) fn get_attachment_preview_path_impl(
    app: &tauri::AppHandle,
    state: &LibraryRootState,
    file_id: &str,
) -> Result<PreviewPathResp> {
    let root = resolve_library_root(app, state)?;
    db::init_db(app, &root)?;
    let conn = Connection::open(root.join("db.sqlite"))?;

    let row = conn
        .query_row(
            "SELECT archive_id, file_type, source_depth, container_virtual_path, virtual_path, cached_path, display_name
             FROM attachments WHERE file_id=?",
            [file_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, Option<String>>(5)?,
                    r.get::<_, String>(6)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| anyhow!("找不到附件: {file_id}"))?;

    let (archive_id, _file_type, source_depth, container_virtual_path, virtual_path, cached_path, display_name) =
        row;

    if let Some(rel) = cached_path {
        let abs = root.join(&rel);
        if abs.exists() {
            return Ok(PreviewPathResp {
                file_id: file_id.to_string(),
                path: abs.to_string_lossy().to_string(),
            });
        }
    }

    // 读取主 ZIP 路径
    let stored_rel: String = conn.query_row(
        "SELECT stored_path FROM archives WHERE archive_id=?",
        [archive_id.as_str()],
        |r| r.get(0),
    )?;
    let zip_abs = root.join(&stored_rel);
    if !zip_abs.exists() {
        return Err(anyhow!("原始ZIP不存在: {}", stored_rel));
    }

    let bytes = if source_depth == 0 {
        read_entry_from_zip_file(&zip_abs, &virtual_path)?
    } else if source_depth == 1 {
        let child_path = container_virtual_path
            .clone()
            .ok_or_else(|| anyhow!("子ZIP附件缺少 container_virtual_path"))?;
        let child_zip_bytes = read_entry_from_zip_file(&zip_abs, &child_path)?;
        read_entry_from_zip_bytes(&child_zip_bytes, &virtual_path)?
    } else {
        return Err(anyhow!("不支持的source_depth: {}", source_depth));
    };

    let ext = Path::new(&display_name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("bin");
    let rel_cache = format!("cache/{archive_id}/{file_id}/content.{ext}");
    let abs_cache = root.join(&rel_cache);
    fs::create_dir_all(abs_cache.parent().unwrap())?;
    fs::write(&abs_cache, bytes)?;

    conn.execute(
        "UPDATE attachments SET cached_path=? WHERE file_id=?",
        params![rel_cache, file_id],
    )?;

    Ok(PreviewPathResp {
        file_id: file_id.to_string(),
        path: abs_cache.to_string_lossy().to_string(),
    })
}

fn read_entry_from_zip_file(zip_path: &Path, virtual_path: &str) -> Result<Vec<u8>> {
    let f = fs::File::open(zip_path)?;
    let mut zip = ZipArchive::new(f)?;
    read_entry_bytes(&mut zip, virtual_path)
}

fn read_entry_from_zip_bytes(zip_bytes: &[u8], virtual_path: &str) -> Result<Vec<u8>> {
    let cursor = std::io::Cursor::new(zip_bytes);
    let mut zip = ZipArchive::new(cursor)?;
    read_entry_bytes(&mut zip, virtual_path)
}

fn read_entry_bytes<R: Read + Seek>(zip: &mut ZipArchive<R>, virtual_path: &str) -> Result<Vec<u8>> {
    if let Ok(mut f) = zip.by_name(virtual_path) {
        let mut buf = Vec::new();
        f.read_to_end(&mut buf)?;
        return Ok(buf);
    }
    // 兜底：扫描 name() 匹配
    for i in 0..zip.len() {
        let mut f = zip.by_index(i)?;
        if f.name() == virtual_path {
            let mut buf = Vec::new();
            f.read_to_end(&mut buf)?;
            return Ok(buf);
        }
    }
    Err(anyhow!("ZIP内找不到条目: {virtual_path}"))
}
