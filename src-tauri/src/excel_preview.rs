use crate::cache;
use crate::db;
use crate::library_root::LibraryRootState;
use crate::library_root::resolve_library_root;
use anyhow::{anyhow, Context, Result};
use calamine::{open_workbook_auto, Data, Reader};
use encoding_rs::GBK;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Read;
use std::path::Path;
use tauri::State;
use zip::ZipArchive;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SheetInfo {
    pub name: String,
    pub rows: usize,
    pub cols: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExcelSheetInfoResp {
    pub file_id: String,
    pub sheets: Vec<SheetInfo>,
    pub default_sheet: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExcelCellsReq {
    pub file_id: String,
    pub sheet_name: String,
    pub row_start: usize,
    pub row_end: usize,
    pub col_start: usize,
    pub col_end: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExcelCellsResp {
    pub row_start: usize,
    pub col_start: usize,
    pub cells: Vec<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct FallbackWorkbook {
    sheets: Vec<FallbackSheet>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct FallbackSheet {
    name: String,
    rows: usize,
    cols: usize,
    cells: Vec<Vec<String>>,
}

#[derive(Debug, Clone)]
struct XlsxSheetMeta {
    name: String,
    _sheet_path: String, // e.g. "xl/worksheets/sheet1.xml"
    rows: usize,
    cols: usize,
}

#[tauri::command]
pub fn get_excel_sheet_info(
    app: tauri::AppHandle,
    state: State<'_, LibraryRootState>,
    file_id: String,
) -> Result<ExcelSheetInfoResp, String> {
    get_excel_sheet_info_impl(&app, &state, &file_id).map_err(db::err_to_string)
}

fn get_excel_sheet_info_impl(
    app: &tauri::AppHandle,
    state: &LibraryRootState,
    file_id: &str,
) -> Result<ExcelSheetInfoResp> {
    let preview = cache::get_attachment_preview_path_impl(app, state, file_id)
        .context("获取Excel预览文件失败")?;
    let path = Path::new(&preview.path);
    if path
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.starts_with("._"))
        .unwrap_or(false)
    {
        return Err(anyhow!("这是 macOS 资源文件（以 ._ 开头），可忽略"));
    }
    match open_workbook_auto(path) {
        Ok(mut workbook) => {
            let sheet_names = workbook.sheet_names().to_vec();
            let mut sheets = Vec::new();
            for name in &sheet_names {
                let (rows, cols) = match workbook.worksheet_range(name) {
                    Ok(range) => (range.height(), range.width()),
                    Err(_) => (0, 0),
                };
                sheets.push(SheetInfo {
                    name: name.to_string(),
                    rows,
                    cols,
                });
            }
            Ok(ExcelSheetInfoResp {
                file_id: file_id.to_string(),
                default_sheet: sheet_names.first().map(|s| s.to_string()),
                sheets,
            })
        }
        Err(e) => {
            // 常见：很多“*.xls”其实是 xlsx(zip)/HTML/CSV/TSV 伪装；做降级解析，确保能预览
            let root = resolve_library_root(app, state)?;
            db::init_db(app, &root)?;
            let conn = rusqlite::Connection::open(root.join("db.sqlite"))?;
            let archive_id: String = conn
                .query_row(
                    "SELECT archive_id FROM attachments WHERE file_id=?",
                    [file_id],
                    |r| r.get(0),
                )
                .with_context(|| format!("找不到附件: {file_id}"))?;

            let kind = sniff_kind(path).unwrap_or(FileKind::Unknown);
            match kind {
                FileKind::Zip => {
                    let metas = xlsx_list_sheets(path)
                        .with_context(|| format!("打开Excel失败: {e:#}"))?;
                    if metas.is_empty() {
                        return Err(anyhow!("打开Excel失败: 该xlsx(zip)内未找到可用sheet"));
                    }
                    Ok(ExcelSheetInfoResp {
                        file_id: file_id.to_string(),
                        default_sheet: Some(metas[0].name.clone()),
                        sheets: metas
                            .into_iter()
                            .map(|m| SheetInfo {
                                name: m.name,
                                rows: m.rows,
                                cols: m.cols,
                            })
                            .collect(),
                    })
                }
                _ => {
                    let fb = load_or_build_fallback(&root, &archive_id, file_id, path)
                        .with_context(|| format!("打开Excel失败: {e:#}"))?;
                    let mut sheets = Vec::new();
                    for s in &fb.sheets {
                        sheets.push(SheetInfo {
                            name: s.name.clone(),
                            rows: s.rows,
                            cols: s.cols,
                        });
                    }
                    Ok(ExcelSheetInfoResp {
                        file_id: file_id.to_string(),
                        default_sheet: fb.sheets.first().map(|s| s.name.clone()),
                        sheets,
                    })
                }
            }
        }
    }
}

#[tauri::command]
pub fn get_excel_sheet_cells(
    app: tauri::AppHandle,
    state: State<'_, LibraryRootState>,
    req: ExcelCellsReq,
) -> Result<ExcelCellsResp, String> {
    get_excel_sheet_cells_impl(&app, &state, req).map_err(db::err_to_string)
}

fn get_excel_sheet_cells_impl(
    app: &tauri::AppHandle,
    state: &LibraryRootState,
    req: ExcelCellsReq,
) -> Result<ExcelCellsResp> {
    if req.row_end <= req.row_start || req.col_end <= req.col_start {
        return Err(anyhow!("无效的范围"));
    }

    let preview = cache::get_attachment_preview_path_impl(app, state, &req.file_id)
        .context("获取Excel预览文件失败")?;
    let path = Path::new(&preview.path);
    if path
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.starts_with("._"))
        .unwrap_or(false)
    {
        return Err(anyhow!("这是 macOS 资源文件（以 ._ 开头），可忽略"));
    }
    match open_workbook_auto(path) {
        Ok(mut workbook) => {
            let range = workbook
                .worksheet_range(&req.sheet_name)
                .context("读取sheet失败")?;

            let mut cells = Vec::new();
            for r in req.row_start..req.row_end {
                let mut row = Vec::new();
                for c in req.col_start..req.col_end {
                    let v = range.get((r, c)).unwrap_or(&Data::Empty);
                    row.push(cell_to_string(v));
                }
                cells.push(row);
            }

            Ok(ExcelCellsResp {
                row_start: req.row_start,
                col_start: req.col_start,
                cells,
            })
        }
        Err(e) => {
            let root = resolve_library_root(app, state)?;
            db::init_db(app, &root)?;
            let conn = rusqlite::Connection::open(root.join("db.sqlite"))?;
            let archive_id: String = conn
                .query_row(
                    "SELECT archive_id FROM attachments WHERE file_id=?",
                    [req.file_id.as_str()],
                    |r| r.get(0),
                )
                .with_context(|| format!("找不到附件: {}", req.file_id))?;
            let kind = sniff_kind(path).unwrap_or(FileKind::Unknown);
            match kind {
                FileKind::Zip => {
                    let cells = xlsx_read_cells_window(
                        path,
                        &req.sheet_name,
                        req.row_start,
                        req.row_end,
                        req.col_start,
                        req.col_end,
                    )
                    .with_context(|| format!("打开Excel失败: {e:#}"))?;
                    Ok(ExcelCellsResp {
                        row_start: req.row_start,
                        col_start: req.col_start,
                        cells,
                    })
                }
                _ => {
                    let fb = load_or_build_fallback(&root, &archive_id, &req.file_id, path)
                        .with_context(|| format!("打开Excel失败: {e:#}"))?;
                    let sheet = fb
                        .sheets
                        .iter()
                        .find(|s| s.name == req.sheet_name)
                        .ok_or_else(|| anyhow!("找不到sheet: {}", req.sheet_name))?;

                    let mut cells = Vec::new();
                    for r in req.row_start..req.row_end {
                        let mut row = Vec::new();
                        for c in req.col_start..req.col_end {
                            let v = sheet
                                .cells
                                .get(r)
                                .and_then(|rr| rr.get(c))
                                .cloned()
                                .unwrap_or_default();
                            row.push(v);
                        }
                        cells.push(row);
                    }
                    Ok(ExcelCellsResp {
                        row_start: req.row_start,
                        col_start: req.col_start,
                        cells,
                    })
                }
            }
        }
    }
}

fn cell_to_string(v: &Data) -> String {
    match v {
        Data::Empty => String::new(),
        Data::String(s) => s.to_string(),
        Data::Float(f) => {
            if f.fract() == 0.0 {
                format!("{:.0}", f)
            } else {
                f.to_string()
            }
        }
        Data::Int(i) => i.to_string(),
        Data::Bool(b) => b.to_string(),
        Data::DateTime(f) => f.to_string(),
        Data::DateTimeIso(s) => s.to_string(),
        Data::DurationIso(s) => s.to_string(),
        Data::Error(e) => format!("错误:{e:?}"),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FileKind {
    Ole,
    Zip,
    Unknown,
}

fn sniff_kind(path: &Path) -> Result<FileKind> {
    let mut f = fs::File::open(path)?;
    let mut head = [0u8; 8];
    let n = f.read(&mut head)?;
    let head = &head[..n];
    if head.starts_with(&[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]) {
        return Ok(FileKind::Ole);
    }
    if head.starts_with(b"PK\x03\x04") {
        return Ok(FileKind::Zip);
    }
    Ok(FileKind::Unknown)
}

fn fallback_cache_path(_root: &Path, archive_id: &str, file_id: &str) -> String {
    format!("cache/{archive_id}/{file_id}/excel_fallback.json")
}

fn load_or_build_fallback(
    root: &Path,
    archive_id: &str,
    file_id: &str,
    source_path: &Path,
) -> Result<FallbackWorkbook> {
    let rel = fallback_cache_path(root, archive_id, file_id);
    let abs = root.join(&rel);
    if abs.exists() {
        let bytes = fs::read(&abs).with_context(|| format!("读取缓存失败: {}", abs.display()))?;
        let wb: FallbackWorkbook = serde_json::from_slice(&bytes).context("解析excel降级缓存失败")?;
        if !wb.sheets.is_empty() {
            return Ok(wb);
        }
    }

    let wb = parse_excel_like_as_table(source_path)?;
    fs::create_dir_all(abs.parent().unwrap())?;
    fs::write(&abs, serde_json::to_vec(&wb)?)?;
    Ok(wb)
}

fn parse_excel_like_as_table(path: &Path) -> Result<FallbackWorkbook> {
    let bytes = fs::read(path).with_context(|| format!("读取文件失败: {}", path.display()))?;
    let bytes = if bytes.len() > 8 * 1024 * 1024 {
        &bytes[..8 * 1024 * 1024]
    } else {
        &bytes
    };

    // 若是标准 Office 文件，直接报错（这里仅处理“伪装xls”）
    if bytes.starts_with(&[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]) {
        return Err(anyhow!("这是标准 xls（OLE），但解析失败，文件可能损坏"));
    }
    if bytes.starts_with(b"PK\x03\x04") {
        return Err(anyhow!("这是 xlsx(zip) 文件，已切换到 xlsx(zip) 降级解析路径"));
    }

    let text = decode_text_guess(bytes);
    let lower = text.to_ascii_lowercase();
    if lower.contains("<table") || lower.contains("<tr") {
        let sheet = parse_html_table(&text)?;
        return Ok(FallbackWorkbook {
            sheets: vec![sheet],
        });
    }

    let sheet = parse_delimited_table(&text)?;
    Ok(FallbackWorkbook {
        sheets: vec![sheet],
    })
}

fn decode_text_guess(bytes: &[u8]) -> String {
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.to_string();
    }
    let (decoded, _, had_errors) = GBK.decode(bytes);
    if !had_errors {
        return decoded.to_string();
    }
    String::from_utf8_lossy(bytes).to_string()
}

fn parse_delimited_table(text: &str) -> Result<FallbackSheet> {
    let mut lines = Vec::new();
    for l in text.lines() {
        let l = l.trim_end_matches('\r');
        if l.trim().is_empty() {
            continue;
        }
        lines.push(l.to_string());
        if lines.len() >= 5000 {
            break;
        }
    }
    if lines.is_empty() {
        return Err(anyhow!("文件内容为空，无法预览"));
    }

    let sample = lines.iter().take(40).map(|s| s.as_str()).collect::<Vec<_>>().join("\n");
    let tab = sample.matches('\t').count();
    let comma = sample.matches(',').count();
    let semi = sample.matches(';').count();
    let delim = if tab >= comma && tab >= semi {
        '\t'
    } else if comma >= semi {
        ','
    } else {
        ';'
    };

    let mut cells: Vec<Vec<String>> = Vec::new();
    let mut max_cols = 0usize;
    for l in lines {
        let row = l
            .split(delim)
            .take(200)
            .map(|s| s.trim().to_string())
            .collect::<Vec<_>>();
        max_cols = max_cols.max(row.len());
        cells.push(row);
    }
    Ok(FallbackSheet {
        name: "Sheet1".to_string(),
        rows: cells.len(),
        cols: max_cols,
        cells,
    })
}

fn parse_html_table(text: &str) -> Result<FallbackSheet> {
    let re_tr = Regex::new(r"(?is)<tr[^>]*>(.*?)</tr>").unwrap();
    let re_td = Regex::new(r"(?is)<t[dh][^>]*>(.*?)</t[dh]>").unwrap();
    let re_tags = Regex::new(r"(?is)<[^>]+>").unwrap();

    let mut cells: Vec<Vec<String>> = Vec::new();
    let mut max_cols = 0usize;
    for cap in re_tr.captures_iter(text).take(5000) {
        let row_html = cap.get(1).map(|m| m.as_str()).unwrap_or("");
        let mut row = Vec::new();
        for cell_cap in re_td.captures_iter(row_html).take(200) {
            let inner = cell_cap.get(1).map(|m| m.as_str()).unwrap_or("");
            let mut v = re_tags.replace_all(inner, "").to_string();
            v = decode_basic_html_entities(&v);
            v = v.replace('\u{00A0}', " ").trim().to_string();
            row.push(v);
        }
        if row.is_empty() {
            continue;
        }
        max_cols = max_cols.max(row.len());
        cells.push(row);
    }
    if cells.is_empty() {
        return Err(anyhow!("未找到可解析的HTML表格"));
    }
    Ok(FallbackSheet {
        name: "HTML".to_string(),
        rows: cells.len(),
        cols: max_cols,
        cells,
    })
}

fn decode_basic_html_entities(s: &str) -> String {
    // 只做最常见实体，避免引入新依赖
    s.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

fn xlsx_list_sheets(path: &Path) -> Result<Vec<XlsxSheetMeta>> {
    let f = fs::File::open(path).with_context(|| format!("打开文件失败: {}", path.display()))?;
    let mut zip = ZipArchive::new(f).context("打开xlsx(zip)失败")?;

    let workbook_xml = read_zip_text(&mut zip, "xl/workbook.xml")
        .context("xlsx缺少 xl/workbook.xml")?;
    let rels_xml = read_zip_text(&mut zip, "xl/_rels/workbook.xml.rels")
        .unwrap_or_default();

    let rels = parse_rels_map(&rels_xml);
    let sheets = parse_workbook_sheets(&workbook_xml, &rels)?;

    let mut out = Vec::new();
    for (name, sheet_path) in sheets {
        let (rows, cols) = match read_zip_text(&mut zip, &sheet_path) {
            Ok(sheet_xml) => parse_sheet_dimension(&sheet_xml).unwrap_or((5000, 200)),
            Err(_) => (5000, 200),
        };
        out.push(XlsxSheetMeta {
            name,
            _sheet_path: sheet_path,
            rows,
            cols,
        });
    }
    Ok(out)
}

fn xlsx_read_cells_window(
    path: &Path,
    sheet_name: &str,
    row_start: usize,
    row_end: usize,
    col_start: usize,
    col_end: usize,
) -> Result<Vec<Vec<String>>> {
    let f = fs::File::open(path).with_context(|| format!("打开文件失败: {}", path.display()))?;
    let mut zip = ZipArchive::new(f).context("打开xlsx(zip)失败")?;

    let workbook_xml = read_zip_text(&mut zip, "xl/workbook.xml")
        .context("xlsx缺少 xl/workbook.xml")?;
    let rels_xml = read_zip_text(&mut zip, "xl/_rels/workbook.xml.rels").unwrap_or_default();
    let rels = parse_rels_map(&rels_xml);
    let sheets = parse_workbook_sheets(&workbook_xml, &rels)?;
    let (_, sheet_path) = sheets
        .iter()
        .find(|(n, _)| n == sheet_name)
        .cloned()
        .ok_or_else(|| anyhow!("找不到sheet: {sheet_name}"))?;

    let shared = read_shared_strings(&mut zip).unwrap_or_default();
    let sheet_xml = read_zip_text(&mut zip, &sheet_path).context("读取sheet.xml失败")?;
    parse_sheet_cells_window(&sheet_xml, &shared, row_start, row_end, col_start, col_end)
}

fn read_zip_text<R: Read + std::io::Seek>(zip: &mut ZipArchive<R>, name: &str) -> Result<String> {
    let mut f = zip.by_name(name)?;
    let mut s = String::new();
    f.read_to_string(&mut s)?;
    Ok(s)
}

fn parse_rels_map(rels_xml: &str) -> std::collections::HashMap<String, String> {
    // Relationship Id -> Target
    let mut out = std::collections::HashMap::<String, String>::new();
    let re = Regex::new(r#"(?is)<Relationship[^>]*\sId="([^"]+)"[^>]*\sTarget="([^"]+)""#).unwrap();
    for cap in re.captures_iter(rels_xml) {
        let id = cap.get(1).unwrap().as_str().to_string();
        let target = cap.get(2).unwrap().as_str().to_string();
        out.insert(id, target);
    }
    out
}

fn parse_workbook_sheets(
    workbook_xml: &str,
    rels: &std::collections::HashMap<String, String>,
) -> Result<Vec<(String, String)>> {
    // 返回 (sheet_name, sheet_xml_path)
    // <sheet name="Sheet1" r:id="rId1" .../>
    let re = Regex::new(r#"(?is)<sheet[^>]*\sname="([^"]+)"[^>]*\sr:id="([^"]+)""#).unwrap();
    let mut out = Vec::new();
    for cap in re.captures_iter(workbook_xml) {
        let name = cap.get(1).unwrap().as_str().to_string();
        let rid = cap.get(2).unwrap().as_str().to_string();
        let target = rels.get(&rid).cloned().unwrap_or_default();
        if target.is_empty() {
            continue;
        }
        let target = if target.starts_with("xl/") {
            target
        } else {
            format!("xl/{target}")
        };
        out.push((name, target));
    }
    if out.is_empty() {
        // 兜底：没有 rels 时尝试按默认路径读取
        // 这种情况下只提供一个 Sheet1
        out.push(("Sheet1".to_string(), "xl/worksheets/sheet1.xml".to_string()));
    }
    Ok(out)
}

fn parse_sheet_dimension(sheet_xml: &str) -> Option<(usize, usize)> {
    // <dimension ref="A1:K44"/>
    let re = Regex::new(r#"(?is)<dimension[^>]*\sref="([^"]+)""#).ok()?;
    let cap = re.captures(sheet_xml)?;
    let r = cap.get(1)?.as_str();
    let parts = r.split(':').collect::<Vec<_>>();
    let last = parts.last().copied().unwrap_or(r);
    let (row, col) = parse_cell_ref(last)?;
    Some((row + 1, col + 1))
}

fn parse_cell_ref(s: &str) -> Option<(usize, usize)> {
    // "BC12" => (11, 54)
    let mut col: usize = 0;
    let mut i = 0usize;
    let bytes = s.as_bytes();
    while i < bytes.len() {
        let b = bytes[i];
        if (b'A'..=b'Z').contains(&b) || (b'a'..=b'z').contains(&b) {
            let v = (b.to_ascii_uppercase() - b'A' + 1) as usize;
            col = col * 26 + v;
            i += 1;
            continue;
        }
        break;
    }
    if col == 0 {
        return None;
    }
    let row_str = &s[i..];
    let row: usize = row_str.parse().ok()?;
    Some((row.saturating_sub(1), col.saturating_sub(1)))
}

fn read_shared_strings<R: Read + std::io::Seek>(zip: &mut ZipArchive<R>) -> Result<Vec<String>> {
    let xml = read_zip_text(zip, "xl/sharedStrings.xml")?;
    // <si><t>..</t></si> 或富文本 <r><t>..</t></r>
    let re_si = Regex::new(r#"(?is)<si[^>]*>(.*?)</si>"#).unwrap();
    let re_t = Regex::new(r#"(?is)<t[^>]*>(.*?)</t>"#).unwrap();
    let re_tags = Regex::new(r"(?is)<[^>]+>").unwrap();
    let mut out = Vec::new();
    for si in re_si.captures_iter(&xml) {
        let inner = si.get(1).map(|m| m.as_str()).unwrap_or("");
        let mut s = String::new();
        for tcap in re_t.captures_iter(inner) {
            let t = tcap.get(1).map(|m| m.as_str()).unwrap_or("");
            let mut v = re_tags.replace_all(t, "").to_string();
            v = decode_basic_html_entities(&v);
            s.push_str(&v);
        }
        out.push(s);
    }
    Ok(out)
}

fn parse_sheet_cells_window(
    sheet_xml: &str,
    shared: &[String],
    row_start: usize,
    row_end: usize,
    col_start: usize,
    col_end: usize,
) -> Result<Vec<Vec<String>>> {
    let rows = row_end.saturating_sub(row_start);
    let cols = col_end.saturating_sub(col_start);
    let mut out = vec![vec![String::new(); cols]; rows];

    // 简化解析：用正则抓 <c r="A1" t="s"><v>0</v></c> 和 inlineStr
    let re_cell = Regex::new(r#"(?is)<c\b([^>]*)>(.*?)</c>"#).unwrap();
    let re_attr_r = Regex::new(r#"(?is)\sr="([^"]+)""#).unwrap();
    let re_attr_t = Regex::new(r#"(?is)\st="([^"]+)""#).unwrap();
    let re_v = Regex::new(r#"(?is)<v[^>]*>(.*?)</v>"#).unwrap();
    let re_is_t = Regex::new(r#"(?is)<is[^>]*>.*?<t[^>]*>(.*?)</t>.*?</is>"#).unwrap();
    let re_tags = Regex::new(r"(?is)<[^>]+>").unwrap();

    for cap in re_cell.captures_iter(sheet_xml) {
        let attrs = cap.get(1).map(|m| m.as_str()).unwrap_or("");
        let inner = cap.get(2).map(|m| m.as_str()).unwrap_or("");
        let rcap = re_attr_r.captures(attrs);
        let Some(rcap) = rcap else { continue };
        let r = rcap.get(1).unwrap().as_str();
        let Some((rr, cc)) = parse_cell_ref(r) else { continue };
        if rr < row_start || rr >= row_end || cc < col_start || cc >= col_end {
            continue;
        }
        let t = re_attr_t
            .captures(attrs)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string());

        let mut value = String::new();
        if t.as_deref() == Some("inlineStr") {
            if let Some(ic) = re_is_t.captures(inner).and_then(|c| c.get(1)) {
                value = re_tags.replace_all(ic.as_str(), "").to_string();
                value = decode_basic_html_entities(&value);
            }
        } else if let Some(vc) = re_v.captures(inner).and_then(|c| c.get(1)) {
            let raw = re_tags.replace_all(vc.as_str(), "").to_string();
            if t.as_deref() == Some("s") {
                if let Ok(idx) = raw.trim().parse::<usize>() {
                    value = shared.get(idx).cloned().unwrap_or_default();
                } else {
                    value = raw;
                }
            } else {
                value = raw;
            }
        }

        let r0 = rr - row_start;
        let c0 = cc - col_start;
        if r0 < rows && c0 < cols {
            out[r0][c0] = value;
        }
    }
    Ok(out)
}
