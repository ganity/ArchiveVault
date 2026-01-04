use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Manager;
use tauri::State;

use crate::db;
use crate::progress;

const TZ: &str = "Asia/Shanghai";
const APP_CONFIG_FILE: &str = "app_config.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LibraryStatus {
    pub library_root: String,
    pub tz: String,
    pub has_data: bool,
}

#[derive(Default)]
pub struct LibraryRootState {
    pub(crate) root: Mutex<Option<PathBuf>>,
}

fn default_library_root(app: &tauri::AppHandle) -> Result<PathBuf> {
    let base = app
        .path()
        .app_data_dir()
        .context("无法获取AppData目录")?;
    Ok(base.join("ArchiveVaultLibrary"))
}

fn ensure_dir(p: &Path) -> Result<()> {
    fs::create_dir_all(p).with_context(|| format!("创建目录失败: {}", p.display()))?;
    Ok(())
}

fn app_config_path(app: &tauri::AppHandle) -> Result<PathBuf> {
    let base = app
        .path()
        .app_data_dir()
        .context("无法获取AppData目录")?;
    ensure_dir(&base)?;
    Ok(base.join(APP_CONFIG_FILE))
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct AppConfig {
    library_root: Option<String>,
}

fn load_app_config(app: &tauri::AppHandle) -> Result<AppConfig> {
    let p = app_config_path(app)?;
    if !p.exists() {
        return Ok(AppConfig::default());
    }
    let bytes = fs::read(&p)?;
    Ok(serde_json::from_slice(&bytes).unwrap_or_default())
}

fn save_app_config(app: &tauri::AppHandle, cfg: &AppConfig) -> Result<()> {
    let p = app_config_path(app)?;
    fs::write(&p, serde_json::to_vec_pretty(cfg)?)?;
    Ok(())
}

pub fn init_default_library(app: &tauri::AppHandle) -> Result<()> {
    let cfg = load_app_config(app)?;
    let root = cfg
        .library_root
        .map(PathBuf::from)
        .unwrap_or(default_library_root(app)?);
    init_library_at(app, &root)?;
    Ok(())
}

fn init_library_at(app: &tauri::AppHandle, root: &Path) -> Result<()> {
    ensure_dir(root)?;
    ensure_dir(&root.join("store"))?;
    ensure_dir(&root.join("cache"))?;
    ensure_dir(&root.join("index"))?;
    db::init_db(app, root)?;
    Ok(())
}

pub fn resolve_library_root(app: &tauri::AppHandle, state: &LibraryRootState) -> Result<PathBuf> {
    if let Some(p) = state.root.lock().unwrap().clone() {
        return Ok(p);
    }
    let cfg = load_app_config(app)?;
    if let Some(root) = cfg.library_root {
        return Ok(PathBuf::from(root));
    }
    Ok(default_library_root(app)?)
}

#[tauri::command]
pub fn pick_folder() -> Result<Option<String>, String> {
    let p = rfd::FileDialog::new().pick_folder();
    Ok(p.map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
pub fn get_library_status(
    app: tauri::AppHandle,
    state: State<'_, LibraryRootState>,
) -> Result<LibraryStatus, String> {
    let root = resolve_library_root(&app, &state).map_err(db::err_to_string)?;
    init_library_at(&app, &root).map_err(db::err_to_string)?;
    let meta = db::read_meta(&app, &root).map_err(db::err_to_string)?;
    let has_data = db::has_any_data(&app, &root).map_err(db::err_to_string)?;
    Ok(LibraryStatus {
        library_root: meta.library_root,
        tz: meta.tz,
        has_data,
    })
}

#[tauri::command]
pub fn set_library_root(
    app: tauri::AppHandle,
    state: State<'_, LibraryRootState>,
    new_root: String,
) -> Result<LibraryStatus, String> {
    let new_root = PathBuf::from(new_root);
    init_library_at(&app, &new_root).map_err(db::err_to_string)?;

    let meta = db::read_meta(&app, &new_root).map_err(db::err_to_string)?;
    let has_data = db::has_any_data(&app, &new_root).map_err(db::err_to_string)?;

    // 若库已存在数据且 meta 记录的 root 不等于 new_root，则禁止直接切换
    let meta_root = PathBuf::from(&meta.library_root);
    if has_data && meta_root != new_root {
        return Err("库目录已有数据，禁止直接修改；请使用迁移功能".to_string());
    }

    // 写入/修复 meta
    db::write_meta(
        &app,
        &new_root,
        db::MetaRecord {
            library_root: new_root.to_string_lossy().to_string(),
            tz: TZ.to_string(),
        },
    )
    .map_err(db::err_to_string)?;

    *state.root.lock().unwrap() = Some(new_root.clone());
    if let Err(e) = save_app_config(
        &app,
        &AppConfig {
            library_root: Some(new_root.to_string_lossy().to_string()),
        },
    ) {
        eprintln!("保存应用配置失败: {e:#}");
    }

    Ok(LibraryStatus {
        library_root: new_root.to_string_lossy().to_string(),
        tz: TZ.to_string(),
        has_data,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MigrateRequest {
    pub from_root: String,
    pub to_root: String,
}

#[tauri::command]
pub fn migrate_library_minimal_move(
    app: tauri::AppHandle,
    state: State<'_, LibraryRootState>,
    req: MigrateRequest,
) -> Result<String, String> {
    let from_root = PathBuf::from(req.from_root);
    let to_root_str = req.to_root.clone();
    let to_root = PathBuf::from(req.to_root);
    let archive_ids = db::list_archive_ids_at(&from_root).map_err(db::err_to_string)?;
    // 进度拆分：准备(1) + 复制db(1) + 复制N个store(archive_ids.len) + 校验(1) + 清理(1)
    let total = archive_ids.len() + 4;
    progress::emit(
        &app,
        progress::ProgressEvent::new("migrate", 0, total, "开始迁移", "准备迁移"),
    );
    migrate_minimal_move(&app, &from_root, &to_root, &archive_ids, total).map_err(db::err_to_string)?;
    progress::emit(
        &app,
        progress::ProgressEvent::new("migrate", total - 1, total, "收尾", "更新配置"),
    );
    *state.root.lock().unwrap() = Some(to_root);
    if let Err(e) = save_app_config(
        &app,
        &AppConfig {
            library_root: Some(to_root_str),
        },
    ) {
        eprintln!("保存应用配置失败: {e:#}");
    }
    progress::emit(&app, progress::ProgressEvent::complete("migrate", "迁移完成"));
    Ok("迁移完成".to_string())
}

fn migrate_minimal_move(
    app: &tauri::AppHandle,
    from_root: &Path,
    to_root: &Path,
    archive_ids: &[String],
    total: usize,
) -> Result<()> {
    if from_root == to_root {
        return Err(anyhow!("迁移失败：源目录与目标目录相同"));
    }
    let from_db = from_root.join("db.sqlite");
    if !from_db.exists() {
        return Err(anyhow!("迁移失败：源库缺少 db.sqlite"));
    }
    if to_root.exists() && fs::read_dir(to_root).ok().and_then(|mut it| it.next()).is_some() {
        return Err(anyhow!("迁移失败：目标目录非空"));
    }
    ensure_dir(to_root)?;
    ensure_dir(&to_root.join("store"))?;
    ensure_dir(&to_root.join("cache"))?;
    ensure_dir(&to_root.join("index"))?;

    // 阶段1：复制 db
    progress::emit(
        app,
        progress::ProgressEvent::new("migrate", 1, total, "复制DB", "复制 db.sqlite"),
    );
    fs::copy(&from_db, to_root.join("db.sqlite")).context("复制 db.sqlite 失败")?;

    // 复制被引用的 store/<archive_id> 目录
    for (i, archive_id) in archive_ids.iter().enumerate() {
        progress::emit(
            app,
            progress::ProgressEvent::new(
                "migrate",
                2 + i,
                total,
                "复制数据",
                &format!("复制 store/{}", archive_id),
            ),
        );
        let src_dir = from_root.join("store").join(archive_id);
        if !src_dir.exists() {
            return Err(anyhow!("迁移失败：缺少源数据目录 store/{}", archive_id));
        }
        let dst_dir = to_root.join("store").join(archive_id);
        copy_dir_all(&src_dir, &dst_dir).with_context(|| format!("复制 store/{} 失败", archive_id))?;
    }

    // 阶段2：写 meta 到新库（并校验 stored_path 都存在）
    progress::emit(
        app,
        progress::ProgressEvent::new("migrate", total - 2, total, "校验", "写入 meta 并校验 ZIP 路径"),
    );
    db::write_meta(
        app,
        to_root,
        db::MetaRecord {
            library_root: to_root.to_string_lossy().to_string(),
            tz: TZ.to_string(),
        },
    )?;
    db::validate_store_paths_at(to_root).context("迁移校验失败：新库缺少部分 ZIP 文件")?;

    // 阶段3：清理旧库（仅删除 DB 引用的 store/<archive_id>，最后删除 db.sqlite）
    progress::emit(
        app,
        progress::ProgressEvent::new("migrate", total - 1, total, "清理旧库", "删除旧库引用的数据"),
    );
    for archive_id in archive_ids {
        let src_dir = from_root.join("store").join(archive_id);
        if src_dir.exists() {
            fs::remove_dir_all(&src_dir)
                .with_context(|| format!("清理旧库 store/{} 失败", archive_id))?;
        }
    }
    // 删除旧 db.sqlite（保留 cache/index 等非必需内容）
    fs::remove_file(&from_db).context("清理旧库 db.sqlite 失败")?;

    Ok(())
}

fn copy_dir_all(src: &Path, dst: &Path) -> Result<()> {
    ensure_dir(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_all(&from, &to)?;
        } else {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}
