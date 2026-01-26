use crate::library_root::{resolve_library_root, LibraryRootState};
use crate::progress;
use anyhow::{anyhow, Context, Result};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::State;

pub fn err_to_string(e: anyhow::Error) -> String {
    format!("{e:#}")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetaRecord {
    pub library_root: String,
    pub tz: String,
}

fn db_path(root: &Path) -> PathBuf {
    root.join("db.sqlite")
}

fn open_conn_at(root: &Path) -> Result<Connection> {
    let p = db_path(root);
    let conn = Connection::open(p).context("打开 db.sqlite 失败")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(conn)
}

pub fn init_db(app: &tauri::AppHandle, root: &Path) -> Result<()> {
    let conn = open_conn_at(root)?;
    apply_migrations(&conn)?;
    // 确保批注FTS存在并与主表一致（数据量小，直接对齐）
    ensure_annotations_fts_synced(&conn)?;
    // 修复/写入 meta
    let existing: Option<String> = conn
        .query_row("SELECT value FROM meta WHERE key='library_root'", [], |r| {
            r.get(0)
        })
        .optional()?;
    if existing.is_none() {
        write_meta(
            app,
            root,
            MetaRecord {
                library_root: root.to_string_lossy().to_string(),
                tz: "Asia/Shanghai".to_string(),
            },
        )?;
    }
    Ok(())
}

fn ensure_annotations_fts_synced(conn: &Connection) -> Result<()> {
    let a_cnt: i64 = conn.query_row("SELECT COUNT(1) FROM annotations", [], |r| r.get(0))?;
    let f_cnt: i64 = conn
        .query_row("SELECT COUNT(1) FROM annotations_fts", [], |r| r.get(0))
        .unwrap_or(0);
    if a_cnt == 0 && f_cnt == 0 {
        return Ok(());
    }
    if a_cnt != f_cnt {
        rebuild_annotations_fts(conn)?;
    }
    Ok(())
}

pub fn rebuild_annotations_fts(conn: &Connection) -> Result<()> {
    conn.execute("DELETE FROM annotations_fts", [])?;
    let mut stmt = conn.prepare("SELECT archive_id, annotation_id, content FROM annotations")?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })?;
    let mut ins = conn.prepare(
        "INSERT INTO annotations_fts(archive_id,annotation_id,search_text,source_text) VALUES(?,?,?,?)",
    )?;
    for row in rows {
        let (archive_id, annotation_id, content) = row?;
        let search_text = crate::search::build_search_text(&content);
        ins.execute([archive_id, annotation_id, search_text, content])?;
    }
    Ok(())
}

fn apply_migrations(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        r#"
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS archives (
  archive_id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  source_path TEXT,
  stored_path TEXT NOT NULL,
  zip_date INTEGER NOT NULL,
  imported_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  error TEXT
);

CREATE TABLE IF NOT EXISTS main_doc (
  archive_id TEXT PRIMARY KEY,
  instruction_no TEXT NOT NULL,
  title TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  content TEXT NOT NULL,
  field_block_map_json TEXT NOT NULL,
  FOREIGN KEY(archive_id) REFERENCES archives(archive_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS docx_blocks (
  archive_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY(archive_id, block_id),
  FOREIGN KEY(archive_id) REFERENCES archives(archive_id) ON DELETE CASCADE
);

CREATE VIRTUAL TABLE IF NOT EXISTS docx_blocks_fts USING fts5(
  archive_id UNINDEXED,
  block_id UNINDEXED,
  search_text,
  source_text
);

CREATE VIRTUAL TABLE IF NOT EXISTS main_doc_fts USING fts5(
  archive_id UNINDEXED,
  field_name UNINDEXED,
  search_text,
  source_text
);

CREATE TABLE IF NOT EXISTS attachments (
  file_id TEXT PRIMARY KEY,
  archive_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  file_type TEXT NOT NULL,
  source_depth INTEGER NOT NULL,
  container_virtual_path TEXT,
  virtual_path TEXT NOT NULL,
  cached_path TEXT,
  size_bytes INTEGER,
  FOREIGN KEY(archive_id) REFERENCES archives(archive_id) ON DELETE CASCADE
);

CREATE VIRTUAL TABLE IF NOT EXISTS attachments_fts USING fts5(
  archive_id UNINDEXED,
  file_id UNINDEXED,
  search_text,
  display_name
);

CREATE VIRTUAL TABLE IF NOT EXISTS annotations_fts USING fts5(
  archive_id UNINDEXED,
  annotation_id UNINDEXED,
  search_text,
  source_text
);

CREATE TABLE IF NOT EXISTS annotations (
  annotation_id TEXT PRIMARY KEY,
  archive_id TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_ref TEXT NOT NULL,
  locator_json TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(archive_id) REFERENCES archives(archive_id) ON DELETE CASCADE
);
"#,
    )?;
    Ok(())
}

pub fn write_meta(app: &tauri::AppHandle, root: &Path, meta: MetaRecord) -> Result<()> {
    let mut conn = open_conn_at(root)?;
    apply_migrations(&conn)?;
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO meta(key,value) VALUES('library_root',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [meta.library_root.as_str()],
    )?;
    tx.execute(
        "INSERT INTO meta(key,value) VALUES('tz',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [meta.tz.as_str()],
    )?;
    tx.commit()?;
    // 确保 tauri asset scope 仍在 APPDATA 下（当前配置如此）；库目录可以在任意位置时，预览建议走 assetProtocol 或 convertFileSrc
    let _ = app; // 预留
    Ok(())
}

pub fn read_meta(_app: &tauri::AppHandle, root: &Path) -> Result<MetaRecord> {
    let conn = open_conn_at(root)?;
    apply_migrations(&conn)?;
    let library_root: String = conn
        .query_row("SELECT value FROM meta WHERE key='library_root'", [], |r| {
            r.get(0)
        })
        .context("meta 缺少 library_root")?;
    let tz: String = conn
        .query_row("SELECT value FROM meta WHERE key='tz'", [], |r| r.get(0))
        .unwrap_or_else(|_| "Asia/Shanghai".to_string());
    Ok(MetaRecord { library_root, tz })
}

pub fn has_any_data(_app: &tauri::AppHandle, root: &Path) -> Result<bool> {
    let conn = open_conn_at(root)?;
    apply_migrations(&conn)?;
    let count: i64 = conn.query_row("SELECT COUNT(1) FROM archives", [], |r| r.get(0))?;
    Ok(count > 0)
}

pub fn list_archive_ids_at(root: &Path) -> Result<Vec<String>> {
    let conn = open_conn_at(root)?;
    apply_migrations(&conn)?;
    let mut stmt = conn.prepare("SELECT archive_id FROM archives")?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn validate_store_paths_at(root: &Path) -> Result<()> {
    let conn = open_conn_at(root)?;
    let mut stmt = conn.prepare("SELECT archive_id, stored_path FROM archives")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    for row in rows {
        let (archive_id, stored_path) = row?;
        let p = root.join(&stored_path);
        if !p.exists() {
            return Err(anyhow!(
                "缺少ZIP文件: archive_id={archive_id} path={stored_path}"
            ));
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArchiveRow {
    pub archive_id: String,
    pub original_name: String,
    pub stored_path: String,
    pub zip_date: i64,
    pub imported_at: i64,
    pub status: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MainDocRow {
    pub instruction_no: String,
    pub title: String,
    pub issued_at: String,
    pub content: String,
    pub field_block_map_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachmentRow {
    pub file_id: String,
    pub display_name: String,
    pub file_type: String,
    pub source_depth: i64,
    pub container_virtual_path: Option<String>,
    pub virtual_path: String,
    pub cached_path: Option<String>,
    pub size_bytes: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnnotationRow {
    pub annotation_id: String,
    pub target_kind: String,
    pub target_ref: String,
    pub locator: serde_json::Value,
    pub content: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArchiveDetail {
    pub archive: ArchiveRow,
    pub main_doc: Option<MainDocRow>,
    pub attachments: Vec<AttachmentRow>,
    pub annotations: Vec<AnnotationRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListArchivesReq {
    pub date_from: Option<i64>,
    pub date_to: Option<i64>,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArchiveListItem {
    pub archive_id: String,
    pub original_name: String,
    pub zip_date: i64,
    pub imported_at: i64,
    pub status: String,
    pub instruction_no: Option<String>,
    pub title: Option<String>,
    pub content: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TopicItem {
    pub title: String,
    pub archive_count: i64,
    pub latest_date: i64,
    pub earliest_date: i64,
    pub archives: Vec<ArchiveListItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListTopicsRequest {
    pub date_from: Option<i64>,
    pub date_to: Option<i64>,
    pub search_query: Option<String>,
    pub sort_desc: Option<bool>,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

#[tauri::command]
pub fn list_archives(
    app: tauri::AppHandle,
    state: State<'_, LibraryRootState>,
    req: Option<ListArchivesReq>,
) -> Result<Vec<ArchiveListItem>, String> {
    let (root, conn) = open_conn(&app, &state).map_err(err_to_string)?;
    let _ = root;
    let req = req.unwrap_or(ListArchivesReq {
        date_from: None,
        date_to: None,
        limit: Some(200),
        offset: Some(0),
    });
    let limit = req.limit.unwrap_or(200).min(1000) as i64;
    let offset = req.offset.unwrap_or(0) as i64;
    let mut where_sql = String::new();
    let mut params_vec: Vec<rusqlite::types::Value> = Vec::new();

    if req.date_from.is_some() || req.date_to.is_some() {
        where_sql.push_str(" WHERE a.zip_date BETWEEN ? AND ? ");
        params_vec.push(rusqlite::types::Value::from(
            req.date_from.unwrap_or(i64::MIN),
        ));
        params_vec.push(rusqlite::types::Value::from(
            req.date_to.unwrap_or(i64::MAX),
        ));
    }

    let sql = format!(
        "SELECT a.archive_id, a.original_name, a.zip_date, a.imported_at, a.status, m.instruction_no, m.title, m.content
         FROM archives a
         LEFT JOIN main_doc m ON m.archive_id=a.archive_id
         {where_sql}
         ORDER BY a.imported_at DESC
         LIMIT ? OFFSET ?"
    );
    params_vec.push(rusqlite::types::Value::from(limit));
    params_vec.push(rusqlite::types::Value::from(offset));

    let mut stmt = conn.prepare(&sql).map_err(|e| err_to_string(anyhow!(e)))?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(params_vec), |r| {
            Ok(ArchiveListItem {
                archive_id: r.get(0)?,
                original_name: r.get(1)?,
                zip_date: r.get(2)?,
                imported_at: r.get(3)?,
                status: r.get(4)?,
                instruction_no: r.get(5).ok(),
                title: r.get(6).ok(),
                content: r.get(7).ok(),
            })
        })
        .map_err(|e| err_to_string(anyhow!(e)))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| err_to_string(anyhow!(e)))?);
    }
    Ok(out)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeywordSuggestion {
    pub keyword: String,
    pub count: i64,
}

#[tauri::command]
pub fn get_popular_keywords(
    app: tauri::AppHandle,
    state: State<'_, LibraryRootState>,
    limit: Option<usize>,
) -> Result<Vec<KeywordSuggestion>, String> {
    let (_root, conn) = open_conn(&app, &state).map_err(err_to_string)?;
    let limit = limit.unwrap_or(20).min(100);

    // 从 main_doc 提取标题和内容中的高频词
    // 使用简单的中文分词方法：提取2-4个字符的连续中文字符
    let sql = r#"
        WITH keywords AS (
            SELECT TRIM(value) as keyword
            FROM (
                SELECT unnest(regexp_split_to_array(title, '([^\u{4e00}-\u{9fa5}]+|[\s、。！？；：，()\[\]]+)')) as value
                FROM main_doc
                WHERE title IS NOT NULL AND title != ''

                UNION ALL

                SELECT unnest(regexp_split_to_array(content, '([^\u{4e00}-\u{9fa5}]+|[\s、。！？；：，()\[\]]+)')) as value
                FROM main_doc
                WHERE content IS NOT NULL AND content != ''
            )
            WHERE length(value) BETWEEN 2 AND 4
        )
        SELECT keyword, COUNT(*) as count
        FROM keywords
        WHERE keyword != ''
        GROUP BY keyword
        ORDER BY count DESC
        LIMIT ?
    "#;

    let mut stmt = conn.prepare(sql).map_err(|e| err_to_string(anyhow!(e)))?;
    let rows = stmt
        .query_map([limit as i64], |r| {
            Ok(KeywordSuggestion {
                keyword: r.get(0)?,
                count: r.get(1)?,
            })
        })
        .map_err(|e| err_to_string(anyhow!(e)))?;

    let mut result = Vec::new();
    for row in rows {
        result.push(row.map_err(|e| err_to_string(anyhow!(e)))?);
    }

    Ok(result)
}

#[tauri::command]
pub fn update_archive_title(
    app: tauri::AppHandle,
    state: State<'_, LibraryRootState>,
    archive_id: String,
    new_title: String,
) -> Result<(), String> {
    let (_root, mut conn) = open_conn(&app, &state).map_err(err_to_string)?;

    let tx = conn.transaction().map_err(|e| err_to_string(anyhow!(e)))?;

    // 检查档案是否存在
    let exists: bool = tx
        .query_row(
            "SELECT COUNT(1) FROM archives WHERE archive_id=?",
            [&archive_id],
            |r| r.get(0),
        )
        .map_err(|e| err_to_string(anyhow!(e).context("检查档案失败")))?;

    if !exists {
        return Err(format!("档案 {} 不存在", archive_id));
    }

    // 检查 main_doc 记录是否存在
    let has_main_doc: bool = tx
        .query_row(
            "SELECT COUNT(1) FROM main_doc WHERE archive_id=?",
            [&archive_id],
            |r| r.get(0),
        )
        .map_err(|e| err_to_string(anyhow!(e).context("检查 main_doc 失败")))?;

    if has_main_doc {
        // 更新 main_doc 表
        tx.execute(
            "UPDATE main_doc SET title=? WHERE archive_id=?",
            [&new_title, &archive_id],
        )
        .map_err(|e| err_to_string(anyhow!(e).context("更新标题失败")))?;

        // 更新 main_doc_fts 索引
        // 先删除旧的索引
        tx.execute(
            "DELETE FROM main_doc_fts WHERE archive_id=? AND field_name='title'",
            [&archive_id],
        )
        .map_err(|e| err_to_string(anyhow!(e).context("删除旧索引失败")))?;

        // 重建搜索文本并插入新索引
        let search_text = crate::search::build_search_text(&new_title);
        tx.execute(
            "INSERT INTO main_doc_fts(archive_id, field_name, search_text, source_text) VALUES(?, 'title', ?, ?)",
            [&archive_id, &search_text, &new_title],
        )
        .map_err(|e| err_to_string(anyhow!(e).context("更新索引失败")))?;
    } else {
        return Err(format!("档案 {} 没有 main_doc 记录", archive_id));
    }

    tx.commit().map_err(|e| err_to_string(anyhow!(e).context("提交事务失败")))?;

    Ok(())
}

#[tauri::command]
pub fn delete_archive(
    app: tauri::AppHandle,
    state: State<'_, LibraryRootState>,
    archive_id: String,
) -> Result<(), String> {
    let (root, mut conn) = open_conn(&app, &state).map_err(err_to_string)?;
    progress::emit(
        &app,
        progress::ProgressEvent::new("delete_archive", 0, 2, "开始", "删除档案数据"),
    );
    delete_archive_impl(&root, &mut conn, &archive_id).map_err(err_to_string)?;
    progress::emit(
        &app,
        progress::ProgressEvent::complete("delete_archive", "删除完成"),
    );
    Ok(())
}

fn delete_archive_impl(root: &Path, conn: &mut Connection, archive_id: &str) -> Result<()> {
    // 删除 store/<archive_id> 目录（先删除文件，再删DB）
    let store_dir = root.join("store").join(archive_id);
    if store_dir.exists() {
        std::fs::remove_dir_all(&store_dir)
            .with_context(|| format!("删除store目录失败: {}", store_dir.display()))?;
    }

    let tx = conn.transaction().context("开启事务失败")?;

    // 先清理FTS（不依赖外部内容表的自动同步）
    tx.execute(
        "DELETE FROM docx_blocks_fts WHERE archive_id=?",
        [archive_id],
    )?;
    tx.execute("DELETE FROM main_doc_fts WHERE archive_id=?", [archive_id])?;
    tx.execute(
        "DELETE FROM attachments_fts WHERE archive_id=?",
        [archive_id],
    )?;
    tx.execute(
        "DELETE FROM annotations_fts WHERE archive_id=?",
        [archive_id],
    )?;

    // 再删除主表（外键级联清理 main_doc/docx_blocks/attachments/annotations）
    tx.execute("DELETE FROM archives WHERE archive_id=?", [archive_id])?;
    tx.commit()?;
    Ok(())
}

#[tauri::command]
pub fn get_archive_detail(
    app: tauri::AppHandle,
    state: State<'_, LibraryRootState>,
    archive_id: String,
) -> Result<ArchiveDetail, String> {
    let (_root, conn) = open_conn(&app, &state).map_err(err_to_string)?;

    let archive: ArchiveRow = conn
        .query_row(
            "SELECT archive_id, original_name, stored_path, zip_date, imported_at, status, error FROM archives WHERE archive_id=?",
            [archive_id.as_str()],
            |r| {
                Ok(ArchiveRow {
                    archive_id: r.get(0)?,
                    original_name: r.get(1)?,
                    stored_path: r.get(2)?,
                    zip_date: r.get(3)?,
                    imported_at: r.get(4)?,
                    status: r.get(5)?,
                    error: r.get(6).ok(),
                })
            },
        )
        .map_err(|e| err_to_string(anyhow!(e).context("读取 archives 失败")))?;

    let main_doc: Option<MainDocRow> = conn
        .query_row(
            "SELECT instruction_no,title,issued_at,content,field_block_map_json FROM main_doc WHERE archive_id=?",
            [archive_id.as_str()],
            |r| {
                Ok(MainDocRow {
                    instruction_no: r.get(0)?,
                    title: r.get(1)?,
                    issued_at: r.get(2)?,
                    content: r.get(3)?,
                    field_block_map_json: r.get(4)?,
                })
            },
        )
        .optional()
        .map_err(|e| err_to_string(anyhow!(e)))?;

    let mut attachments = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT file_id,display_name,file_type,source_depth,container_virtual_path,virtual_path,cached_path,size_bytes FROM attachments WHERE archive_id=? ORDER BY source_depth, display_name",
            )
            .map_err(|e| err_to_string(anyhow!(e)))?;
        let rows = stmt
            .query_map([archive_id.as_str()], |r| {
                Ok(AttachmentRow {
                    file_id: r.get(0)?,
                    display_name: r.get(1)?,
                    file_type: r.get(2)?,
                    source_depth: r.get(3)?,
                    container_virtual_path: r.get(4).ok(),
                    virtual_path: r.get(5)?,
                    cached_path: r.get(6).ok(),
                    size_bytes: r.get(7).ok(),
                })
            })
            .map_err(|e| err_to_string(anyhow!(e)))?;
        for row in rows {
            attachments.push(row.map_err(|e| err_to_string(anyhow!(e)))?);
        }
    }

    let mut annotations = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT annotation_id,target_kind,target_ref,locator_json,content,created_at,updated_at FROM annotations WHERE archive_id=? ORDER BY created_at DESC",
            )
            .map_err(|e| err_to_string(anyhow!(e)))?;
        let rows = stmt
            .query_map([archive_id.as_str()], |r| {
                let locator_json: String = r.get(3)?;
                let locator: serde_json::Value =
                    serde_json::from_str(&locator_json).unwrap_or(serde_json::json!({}));
                Ok(AnnotationRow {
                    annotation_id: r.get(0)?,
                    target_kind: r.get(1)?,
                    target_ref: r.get(2)?,
                    locator,
                    content: r.get(4)?,
                    created_at: r.get(5)?,
                    updated_at: r.get(6)?,
                })
            })
            .map_err(|e| err_to_string(anyhow!(e)))?;
        for row in rows {
            annotations.push(row.map_err(|e| err_to_string(anyhow!(e)))?);
        }
    }

    Ok(ArchiveDetail {
        archive,
        main_doc,
        attachments,
        annotations,
    })
}

#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    open_path_impl(&path).map_err(err_to_string)
}

fn open_path_impl(path: &str) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(path).spawn()?;
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", path])
            .spawn()?;
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open").arg(path).spawn()?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Ok(())
}

#[tauri::command]
pub fn list_topics_by_date(
    app: tauri::AppHandle,
    state: State<'_, LibraryRootState>,
    req: Option<ListTopicsRequest>,
) -> Result<Vec<TopicItem>, String> {
    let (root, conn) = open_conn(&app, &state).map_err(err_to_string)?;
    let _ = root;
    let req = req.unwrap_or(ListTopicsRequest {
        date_from: None,
        date_to: None,
        search_query: None,
        sort_desc: Some(true),
        limit: Some(200),
        offset: Some(0),
    });

    let limit = req.limit.unwrap_or(200).min(1000) as i64;
    let offset = req.offset.unwrap_or(0) as i64;
    let sort_desc = req.sort_desc.unwrap_or(true);

    let mut where_conditions = Vec::new();
    let mut params: Vec<rusqlite::types::Value> = Vec::new();

    // 日期范围过滤
    if req.date_from.is_some() || req.date_to.is_some() {
        where_conditions.push("a.zip_date BETWEEN ? AND ?".to_string());
        params.push(rusqlite::types::Value::from(
            req.date_from.unwrap_or(i64::MIN),
        ));
        params.push(rusqlite::types::Value::from(
            req.date_to.unwrap_or(i64::MAX),
        ));
    }

    // 搜索查询过滤
    if let Some(query) = &req.search_query {
        if !query.trim().is_empty() {
            where_conditions.push("(m.title LIKE ? OR m.instruction_no LIKE ?)".to_string());
            let search_pattern = format!("%{}%", query.trim());
            params.push(rusqlite::types::Value::from(search_pattern.clone()));
            params.push(rusqlite::types::Value::from(search_pattern));
        }
    }

    let where_clause = if where_conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", where_conditions.join(" AND "))
    };

    let order_clause = if sort_desc {
        "ORDER BY latest_date DESC"
    } else {
        "ORDER BY latest_date ASC"
    };

    // 主查询：获取主题统计信息
    let topics_sql = format!(
        "SELECT 
            COALESCE(m.title, '无标题') as title,
            COUNT(*) as archive_count,
            MAX(a.zip_date) as latest_date,
            MIN(a.zip_date) as earliest_date
        FROM archives a
        LEFT JOIN main_doc m ON m.archive_id = a.archive_id
        {where_clause}
        GROUP BY COALESCE(m.title, '无标题')
        {order_clause}
        LIMIT ? OFFSET ?"
    );

    let mut topic_params = params.clone();
    topic_params.push(rusqlite::types::Value::from(limit));
    topic_params.push(rusqlite::types::Value::from(offset));

    let mut topics_stmt = conn
        .prepare(&topics_sql)
        .map_err(|e| err_to_string(anyhow!(e)))?;

    let topic_rows = topics_stmt
        .query_map(rusqlite::params_from_iter(topic_params), |r| {
            Ok((
                r.get::<_, String>(0)?, // title
                r.get::<_, i64>(1)?,    // archive_count
                r.get::<_, i64>(2)?,    // latest_date
                r.get::<_, i64>(3)?,    // earliest_date
            ))
        })
        .map_err(|e| err_to_string(anyhow!(e)))?;

    let mut topics = Vec::new();
    for row in topic_rows {
        let (title, archive_count, latest_date, earliest_date) =
            row.map_err(|e| err_to_string(anyhow!(e)))?;
        topics.push((title, archive_count, latest_date, earliest_date));
    }

    let mut result = Vec::new();

    // 为每个主题获取对应的档案列表
    for (title, archive_count, latest_date, earliest_date) in topics {
        let archives_params: Vec<rusqlite::types::Value> =
            vec![rusqlite::types::Value::from(title.clone())];

        let archives_sql = format!(
            "SELECT a.archive_id, a.original_name, a.zip_date, a.imported_at, a.status, m.instruction_no, m.title, m.content
            FROM archives a
            LEFT JOIN main_doc m ON m.archive_id = a.archive_id
            WHERE COALESCE(m.title, '无标题') = ?
            ORDER BY a.zip_date DESC
            LIMIT 50"
        );

        let mut archives_stmt = conn
            .prepare(&archives_sql)
            .map_err(|e| err_to_string(anyhow!(e)))?;

        let archive_rows = archives_stmt
            .query_map(rusqlite::params_from_iter(archives_params), |r| {
                Ok(ArchiveListItem {
                    archive_id: r.get(0)?,
                    original_name: r.get(1)?,
                    zip_date: r.get(2)?,
                    imported_at: r.get(3)?,
                    status: r.get(4)?,
                    instruction_no: r.get(5).ok(),
                    title: r.get(6).ok(),
                    content: r.get(7).ok(),
                })
            })
            .map_err(|e| err_to_string(anyhow!(e)))?;

        let mut archives = Vec::new();
        for archive_row in archive_rows {
            archives.push(archive_row.map_err(|e| err_to_string(anyhow!(e)))?);
        }

        result.push(TopicItem {
            title,
            archive_count,
            latest_date,
            earliest_date,
            archives,
        });
    }

    Ok(result)
}

pub fn open_conn(
    app: &tauri::AppHandle,
    state: &LibraryRootState,
) -> Result<(PathBuf, Connection)> {
    let root = resolve_library_root(app, state)?;
    init_db(app, &root)?;
    let conn = open_conn_at(&root)?;
    Ok((root, conn))
}
