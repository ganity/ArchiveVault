#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod annotations;
mod cache;
mod db;
mod docx;
mod excel_preview;
mod importer;
mod library_root;
mod progress;
mod search;

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .manage(library_root::LibraryRootState::default())
        .setup(|app| {
            // 初始化默认库（若未选择则使用默认目录）
            let handle = app.handle().clone();
            library_root::init_default_library(&handle)?;
            // 初始化运行时选择的库目录
            let state: tauri::State<library_root::LibraryRootState> = app.state();
            let root = library_root::resolve_library_root(&handle, &state)?;
            *state.root.lock().unwrap() = Some(root);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            library_root::get_library_status,
            library_root::set_library_root,
            library_root::migrate_library_minimal_move,
            library_root::pick_folder,
            importer::pick_zip_files,
            importer::pick_zip_folder_files,
            importer::import_zips,
            importer::reparse_main_doc,
            search::search,
            search::search_paged,
            db::list_archives,
            db::get_archive_detail,
            db::delete_archive,
            docx::get_docx_blocks,
            docx::get_docx_attachment_preview,
            cache::get_attachment_preview_path,
            cache::cleanup_cache,
            cache::cleanup_archive_cache,
            excel_preview::get_excel_sheet_info,
            excel_preview::get_excel_sheet_cells,
            annotations::create_annotation,
            annotations::list_annotations,
            annotations::delete_annotation,
            db::open_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
