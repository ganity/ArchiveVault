use crate::db;
use crate::library_root::{resolve_library_root, LibraryRootState};
use anyhow::{anyhow, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateAnnotationReq {
    pub archive_id: String,
    pub target_kind: String, // docx | pdf | media
    pub target_ref: String,  // docx: archive_id; pdf/media: file_id
    pub locator: serde_json::Value,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnnotationResp {
    pub annotation_id: String,
    pub archive_id: String,
    pub target_kind: String,
    pub target_ref: String,
    pub locator: serde_json::Value,
    pub content: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[tauri::command]
pub fn create_annotation(
    app: tauri::AppHandle,
    state: State<'_, LibraryRootState>,
    req: CreateAnnotationReq,
) -> Result<AnnotationResp, String> {
    create_annotation_impl(&app, &state, req).map_err(db::err_to_string)
}

fn create_annotation_impl(
    app: &tauri::AppHandle,
    state: &LibraryRootState,
    req: CreateAnnotationReq,
) -> Result<AnnotationResp> {
    if req.content.trim().is_empty() {
        return Err(anyhow!("批注内容不能为空"));
    }
    let root = resolve_library_root(app, state)?;
    db::init_db(app, &root)?;
    let conn = Connection::open(root.join("db.sqlite"))?;

    let now = chrono::Utc::now().timestamp();
    let id = Uuid::new_v4().to_string();
    let locator_json = serde_json::to_string(&req.locator)?;
    conn.execute(
        "INSERT INTO annotations(annotation_id,archive_id,target_kind,target_ref,locator_json,content,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?)",
        params![
            id,
            req.archive_id,
            req.target_kind,
            req.target_ref,
            locator_json,
            req.content,
            now,
            now
        ],
    )?;

    // 同步写入 FTS（用于搜索批注内容）
    let search_text = crate::search::build_search_text(&req.content);
    conn.execute(
        "INSERT INTO annotations_fts(archive_id,annotation_id,search_text,source_text) VALUES(?,?,?,?)",
        params![req.archive_id, id, search_text, req.content],
    )?;
    Ok(AnnotationResp {
        annotation_id: id,
        archive_id: req.archive_id,
        target_kind: req.target_kind,
        target_ref: req.target_ref,
        locator: req.locator,
        content: req.content,
        created_at: now,
        updated_at: now,
    })
}

#[tauri::command]
pub fn list_annotations(
    app: tauri::AppHandle,
    state: State<'_, LibraryRootState>,
    archive_id: String,
) -> Result<Vec<AnnotationResp>, String> {
    list_annotations_impl(&app, &state, &archive_id).map_err(db::err_to_string)
}

fn list_annotations_impl(
    app: &tauri::AppHandle,
    state: &LibraryRootState,
    archive_id: &str,
) -> Result<Vec<AnnotationResp>> {
    let root = resolve_library_root(app, state)?;
    db::init_db(app, &root)?;
    let conn = Connection::open(root.join("db.sqlite"))?;
    let mut stmt = conn.prepare(
        "SELECT annotation_id,archive_id,target_kind,target_ref,locator_json,content,created_at,updated_at
         FROM annotations WHERE archive_id=? ORDER BY created_at DESC",
    )?;
    let rows = stmt.query_map([archive_id], |r| {
        let locator_json: String = r.get(4)?;
        let locator = serde_json::from_str(&locator_json).unwrap_or(serde_json::json!({}));
        Ok(AnnotationResp {
            annotation_id: r.get(0)?,
            archive_id: r.get(1)?,
            target_kind: r.get(2)?,
            target_ref: r.get(3)?,
            locator,
            content: r.get(5)?,
            created_at: r.get(6)?,
            updated_at: r.get(7)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

#[tauri::command]
pub fn delete_annotation(
    app: tauri::AppHandle,
    state: State<'_, LibraryRootState>,
    annotation_id: String,
) -> Result<(), String> {
    delete_annotation_impl(&app, &state, &annotation_id).map_err(db::err_to_string)
}

fn delete_annotation_impl(
    app: &tauri::AppHandle,
    state: &LibraryRootState,
    annotation_id: &str,
) -> Result<()> {
    let root = resolve_library_root(app, state)?;
    db::init_db(app, &root)?;
    let conn = Connection::open(root.join("db.sqlite"))?;
    conn.execute("DELETE FROM annotations WHERE annotation_id=?", [annotation_id])?;
    conn.execute("DELETE FROM annotations_fts WHERE annotation_id=?", [annotation_id])?;
    Ok(())
}
