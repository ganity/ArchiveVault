use crate::db;
use crate::cache;
use crate::library_root::{resolve_library_root, LibraryRootState};
use anyhow::{anyhow, Context, Result};
use quick_xml::events::Event;
use quick_xml::Reader as XmlReader;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::io::{Cursor, Read};
use std::fs;
use std::path::Path;
use tauri::State;
use zip::ZipArchive;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocxBlock {
    pub block_id: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MainDocParsed {
    pub instruction_no: String,
    pub title: String,
    pub issued_at: String,
    pub content: String,
    pub field_block_map_json: String,
    pub blocks: Vec<DocxBlock>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocxAttachmentPreview {
    pub file_id: String,
    pub paragraphs: Vec<String>,
    pub image_paths: Vec<String>,
}

#[tauri::command]
pub fn get_docx_blocks(
    app: tauri::AppHandle,
    state: State<'_, LibraryRootState>,
    archive_id: String,
) -> Result<Vec<DocxBlock>, String> {
    let root = resolve_library_root(&app, &state).map_err(db::err_to_string)?;
    db::init_db(&app, &root).map_err(db::err_to_string)?;
    let conn = rusqlite::Connection::open(root.join("db.sqlite"))
        .map_err(|e| db::err_to_string(anyhow!(e)))?;
    let mut stmt = conn
        .prepare("SELECT block_id,text FROM docx_blocks WHERE archive_id=? ORDER BY block_id")
        .map_err(|e| db::err_to_string(anyhow!(e)))?;
    let rows = stmt
        .query_map([archive_id.as_str()], |r| {
            Ok(DocxBlock {
                block_id: r.get(0)?,
                text: r.get(1)?,
            })
        })
        .map_err(|e| db::err_to_string(anyhow!(e)))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| db::err_to_string(anyhow!(e)))?);
    }
    Ok(out)
}

#[tauri::command]
pub fn get_docx_attachment_preview(
    app: tauri::AppHandle,
    state: State<'_, LibraryRootState>,
    file_id: String,
) -> Result<DocxAttachmentPreview, String> {
    get_docx_attachment_preview_impl(&app, &state, &file_id).map_err(db::err_to_string)
}

fn get_docx_attachment_preview_impl(
    app: &tauri::AppHandle,
    state: &LibraryRootState,
    file_id: &str,
) -> Result<DocxAttachmentPreview> {
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

    // 复用现有缓存解压逻辑，确保 docx 已被解压到 cache 并记录 cached_path
    let preview = cache::get_attachment_preview_path_impl(app, state, file_id)
        .context("解压docx失败")?;
    let bytes = fs::read(&preview.path).with_context(|| format!("读取docx失败: {}", preview.path))?;

    let document_xml = read_docx_document_xml(&bytes)?;
    let paragraphs = extract_paragraph_texts_ignore_tables_with_pagebreak(&document_xml, true)?;

    // 尝试提取 docx 内嵌图片（常见于附加docx）
    let image_paths = extract_docx_images_to_cache(&bytes, &root, &archive_id, file_id)
        .unwrap_or_default();

    Ok(DocxAttachmentPreview {
        file_id: file_id.to_string(),
        paragraphs,
        image_paths,
    })
}

pub fn parse_main_docx(docx_bytes: &[u8]) -> Result<MainDocParsed> {
    let document_xml = read_docx_document_xml(docx_bytes)?;
    let paragraphs = extract_paragraph_texts_ignore_tables_with_pagebreak(&document_xml, false)?;
    let mut blocks = Vec::new();
    for (idx, text) in paragraphs.into_iter().enumerate() {
        let block_id = format!("p:{:06}", idx + 1);
        blocks.push(DocxBlock { block_id, text });
    }
    let (instruction_no, title, issued_at, content, field_block_map_json) =
        extract_fields_and_map(&blocks)?;

    Ok(MainDocParsed {
        instruction_no,
        title,
        issued_at,
        content,
        field_block_map_json,
        blocks,
    })
}

fn read_docx_document_xml(docx_bytes: &[u8]) -> Result<String> {
    let cursor = Cursor::new(docx_bytes);
    let mut zip = ZipArchive::new(cursor).context("docx不是有效的zip")?;
    let mut f = zip
        .by_name("word/document.xml")
        .context("docx缺少 word/document.xml")?;
    let mut xml = String::new();
    f.read_to_string(&mut xml)?;
    Ok(xml)
}

fn extract_docx_images_to_cache(
    docx_bytes: &[u8],
    library_root: &Path,
    archive_id: &str,
    file_id: &str,
) -> Result<Vec<String>> {
    let cursor = Cursor::new(docx_bytes);
    let mut zip = ZipArchive::new(cursor).context("docx不是有效的zip")?;

    let mut rels_xml = String::new();
    if let Ok(mut f) = zip.by_name("word/_rels/document.xml.rels") {
        f.read_to_string(&mut rels_xml)?;
    } else {
        return Ok(vec![]);
    }

    let rels = parse_docx_relationships(&rels_xml)?;
    if rels.is_empty() {
        return Ok(vec![]);
    }

    let document_xml = read_docx_document_xml(docx_bytes)?;
    let rid_order = collect_embed_rids(&document_xml);
    if rid_order.is_empty() {
        return Ok(vec![]);
    }

    let out_dir = library_root
        .join("cache")
        .join(archive_id)
        .join(file_id)
        .join("docx_media");
    fs::create_dir_all(&out_dir)?;

    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::<String>::new();

    for (idx, rid) in rid_order.into_iter().enumerate().take(30) {
        if !seen.insert(rid.clone()) {
            continue;
        }
        let Some(target) = rels.get(&rid) else {
            continue;
        };
        let norm = normalize_docx_rel_target(target);
        let internal = if norm.starts_with("word/") {
            norm
        } else {
            format!("word/{norm}")
        };

        let mut f = zip
            .by_name(&internal)
            .with_context(|| format!("读取docx图片失败: {internal}"))?;
        let mut buf = Vec::new();
        f.read_to_end(&mut buf)?;

        let ext = Path::new(&internal)
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("bin");
        let abs = out_dir.join(format!("{:02}.{}", idx + 1, ext));
        fs::write(&abs, buf)?;
        out.push(abs.to_string_lossy().to_string());
    }
    Ok(out)
}

fn parse_docx_relationships(rels_xml: &str) -> Result<std::collections::HashMap<String, String>> {
    let mut reader = XmlReader::from_str(rels_xml);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    let mut out = std::collections::HashMap::<String, String>::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Empty(e)) | Ok(Event::Start(e)) => {
                let name = e.name().as_ref().to_vec();
                let n = local_name(&name);
                if n == b"Relationship" {
                    let mut id: Option<String> = None;
                    let mut target: Option<String> = None;
                    let mut ty: Option<String> = None;
                    for a in e.attributes().flatten() {
                        let k = local_name(a.key.as_ref());
                        let v = a.unescape_value()?.to_string();
                        if k == b"Id" {
                            id = Some(v);
                        } else if k == b"Target" {
                            target = Some(v);
                        } else if k == b"Type" {
                            ty = Some(v);
                        }
                    }
                    if let (Some(id), Some(target), Some(ty)) = (id, target, ty) {
                        if ty.contains("/image") {
                            out.insert(id, target);
                        }
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(anyhow!("rels XML解析失败: {e:?}")),
            _ => {}
        }
        buf.clear();
    }
    Ok(out)
}

fn collect_embed_rids(document_xml: &str) -> Vec<String> {
    // docx 图片一般通过 a:blip 的 r:embed="rIdX" 引用
    let re = Regex::new(r#"r:embed="([^"]+)""#).expect("valid regex");
    re.captures_iter(document_xml)
        .filter_map(|c| c.get(1).map(|m| m.as_str().to_string()))
        .collect()
}

fn normalize_docx_rel_target(target: &str) -> String {
    // 常见 target: "media/image1.png" 或 "../media/image1.png"
    let mut t = target.replace('\\', "/");
    while t.starts_with("../") {
        t = t.trim_start_matches("../").to_string();
    }
    t
}

fn local_name(name: &[u8]) -> &[u8] {
    match name.iter().rposition(|b| *b == b':') {
        Some(i) => &name[i + 1..],
        None => name,
    }
}

fn extract_paragraph_texts_ignore_tables_with_pagebreak(
    document_xml: &str,
    mark_pagebreak: bool,
) -> Result<Vec<String>> {
    let mut reader = XmlReader::from_str(document_xml);
    reader.config_mut().trim_text(false);

    let mut buf = Vec::new();
    let mut out = Vec::new();

    let mut table_depth = 0usize;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let name = e.name().as_ref().to_vec();
                let n = local_name(&name);
                if n == b"tbl" {
                    table_depth += 1;
                } else if n == b"p" && table_depth == 0 {
                    let text = read_paragraph_text(&mut reader, &mut table_depth, mark_pagebreak)?;
                    let norm = normalize_text_minimal(&text);
                    out.push(norm);
                }
            }
            Ok(Event::End(e)) => {
                let name = e.name().as_ref().to_vec();
                let n = local_name(&name);
                if n == b"tbl" && table_depth > 0 {
                    table_depth -= 1;
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(anyhow!("XML解析失败: {e:?}")),
            _ => {}
        }
        buf.clear();
    }

    Ok(out)
}

fn read_paragraph_text(
    reader: &mut XmlReader<&[u8]>,
    table_depth: &mut usize,
    mark_pagebreak: bool,
) -> Result<String> {
    let mut buf = Vec::new();
    let mut out = String::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let name = e.name().as_ref().to_vec();
                let n = local_name(&name);
                if n == b"tbl" {
                    *table_depth += 1;
                } else if n == b"t" {
                    // w:t 的文本会在 Event::Text 给出
                } else if n == b"tab" {
                    out.push('\t');
                } else if n == b"lastRenderedPageBreak" {
                    if mark_pagebreak {
                        out.push('\u{000C}');
                    } else {
                        out.push('\n');
                    }
                } else if n == b"br" || n == b"cr" {
                    if mark_pagebreak && n == b"br" {
                        // <w:br w:type="page"/>
                        let mut is_page = false;
                        for a in e.attributes().flatten() {
                            let key = local_name(a.key.as_ref());
                            if key == b"type" {
                                if let Ok(v) = a.unescape_value() {
                                    if v.as_ref() == "page" {
                                        is_page = true;
                                        break;
                                    }
                                }
                            }
                        }
                        if is_page {
                            out.push('\u{000C}');
                        } else {
                            out.push('\n');
                        }
                    } else {
                        out.push('\n');
                    }
                }
            }
            Ok(Event::End(e)) => {
                let name = e.name().as_ref().to_vec();
                let n = local_name(&name);
                if n == b"p" {
                    break;
                }
                if n == b"tbl" && *table_depth > 0 {
                    *table_depth -= 1;
                }
            }
            Ok(Event::Text(t)) => {
                out.push_str(&t.unescape()?.to_string());
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(anyhow!("XML解析失败: {e:?}")),
            _ => {}
        }
        buf.clear();
    }
    Ok(out)
}

fn normalize_text_minimal(s: &str) -> String {
    s.replace("\r\n", "\n")
        .replace('\u{00A0}', " ")
        .replace('\u{3000}', " ")
}

fn extract_fields_and_map(blocks: &[DocxBlock]) -> Result<(String, String, String, String, String)> {
    // 支持两种常见格式：
    // 1) 每行/每段落以“指令标题：xxx”开头
    // 2) 同一段落内连续出现“指令编号：xxx 指令标题：yyy 下发时间：zzz 指令内容：ccc”
    // 兼容：主题/编号/时间/日期/正文 等变体
    let re_label_any = Regex::new(
        r#"(指令编号|编号|文号|发文字号|文件编号|指令号|指令标题|标题|主题|事项|名称|下发时间|时间|日期|下发日期|签发时间|发文日期|指令内容|内容|正文|主要内容)\s*[:：]"#,
    )
    .expect("valid regex");
    let re_label_line = Regex::new(
        r#"^\s*(指令编号|编号|文号|发文字号|文件编号|指令号|指令标题|标题|主题|事项|名称|下发时间|时间|日期|下发日期|签发时间|发文日期)\s*[:：]"#,
    )
    .expect("valid regex");

    let mut instruction_no = String::new();
    let mut title = String::new();
    let mut issued_at = String::new();

    let mut map_instruction_no: Option<String> = None;
    let mut map_title: Option<String> = None;
    let mut map_issued_at: Option<String> = None;
    let mut content_anchor: Option<String> = None;
    let mut content_block_ids: Vec<String> = Vec::new();
    let mut content_lines: Vec<String> = Vec::new();

    enum State {
        Seeking,
        Collecting { start_idx: usize },
    }
    let mut st = State::Seeking;
    let mut pending_single: Option<(&'static str, String)> = None; // (canonical, block_id)

    for (i, b) in blocks.iter().enumerate() {
        let t = b.text.trim();
        let mut hits = Vec::new(); // (key, start, end_of_label)
        for cap in re_label_any.captures_iter(t) {
            let m = cap.get(0).unwrap();
            let key = cap.get(1).unwrap().as_str().to_string();
            hits.push((key, m.start(), m.end()));
        }

        if !hits.is_empty() {
            pending_single = None;
            hits.sort_by(|a, b| a.1.cmp(&b.1));
            for idx in 0..hits.len() {
                let (key, _start, end) = &hits[idx];
                let next_start = hits.get(idx + 1).map(|x| x.1).unwrap_or(t.len());
                let mut rest = t.get(*end..next_start).unwrap_or("").trim();
                // 常见写法里标签后会紧跟空格/换行，统一清理
                rest = rest.trim_matches(|c: char| c == '\n' || c == '\t' || c == ' ' || c == '　');

                let canonical = match key.as_str() {
                    "指令编号" | "编号" | "文号" | "发文字号" | "文件编号" | "指令号" => "instruction_no",
                    "指令标题" | "标题" | "主题" | "事项" | "名称" => "title",
                    "下发时间" | "时间" | "日期" | "下发日期" | "签发时间" | "发文日期" => "issued_at",
                    "指令内容" | "内容" | "正文" | "主要内容" => "content",
                    _ => "unknown",
                };

                match canonical {
                    "instruction_no" => {
                        if instruction_no.is_empty() {
                            if rest.is_empty() {
                                pending_single = Some(("instruction_no", b.block_id.clone()));
                            } else {
                                instruction_no = rest.to_string();
                                map_instruction_no = Some(b.block_id.clone());
                            }
                        }
                    }
                    "title" => {
                        if title.is_empty() {
                            if rest.is_empty() {
                                pending_single = Some(("title", b.block_id.clone()));
                            } else {
                                title = rest.to_string();
                                map_title = Some(b.block_id.clone());
                            }
                        }
                    }
                    "issued_at" => {
                        if issued_at.is_empty() {
                            if rest.is_empty() {
                                pending_single = Some(("issued_at", b.block_id.clone()));
                            } else {
                                issued_at = rest.to_string();
                                map_issued_at = Some(b.block_id.clone());
                            }
                        }
                    }
                    "content" => {
                        if content_anchor.is_none() {
                            content_anchor = Some(b.block_id.clone());
                        }
                        if !rest.is_empty() {
                            content_block_ids.push(b.block_id.clone());
                            content_lines.push(rest.to_string());
                        }
                        // 内容通常是最后一个字段，开启跨段落收集
                        st = State::Collecting { start_idx: i };
                    }
                    _ => {}
                }
            }
            continue;
        }

        if let Some((canonical, block_id)) = pending_single.take() {
            if !t.is_empty() {
                match canonical {
                    "instruction_no" => {
                        if instruction_no.is_empty() {
                            instruction_no = b.text.trim().to_string();
                            map_instruction_no = Some(block_id);
                            continue;
                        }
                    }
                    "title" => {
                        if title.is_empty() {
                            title = b.text.trim().to_string();
                            map_title = Some(block_id);
                            continue;
                        }
                    }
                    "issued_at" => {
                        if issued_at.is_empty() {
                            issued_at = b.text.trim().to_string();
                            map_issued_at = Some(block_id);
                            continue;
                        }
                    }
                    _ => {}
                }
            }
        }

        match st {
            State::Seeking => {}
            State::Collecting { start_idx } => {
                if i <= start_idx {
                    continue;
                }
                // 如果遇到其他字段标签，结束
                if re_label_line.is_match(t) {
                    break;
                }
                if !t.is_empty() {
                    content_block_ids.push(b.block_id.clone());
                    content_lines.push(b.text.clone());
                }
            }
        }
    }

    let content = content_lines.join("\n");
    let field_block_map = json!({
        "instruction_no": map_instruction_no,
        "title": map_title,
        "issued_at": map_issued_at,
        "content": content_block_ids,
        "content_anchor": content_anchor
    });
    let field_block_map_json = serde_json::to_string(&field_block_map)?;
    Ok((
        instruction_no,
        title,
        issued_at,
        content,
        field_block_map_json,
    ))
}
