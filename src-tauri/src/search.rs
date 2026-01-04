use crate::db;
use crate::library_root::{resolve_library_root, LibraryRootState};
use anyhow::Result;
use jieba_rs::Jieba;
use once_cell::sync::Lazy;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use tauri::State;

static JIEBA: Lazy<Jieba> = Lazy::new(Jieba::new);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchFilters {
    pub date_from: Option<i64>,
    pub date_to: Option<i64>,
    pub file_types: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchRequest {
    pub query: String,
    pub filters: Option<SearchFilters>,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Range {
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchPagedResponse {
    pub items: Vec<SearchResult>,
    pub has_more: bool,
    pub offset: usize,
    pub limit: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum SearchResult {
    #[serde(rename = "docx_block")]
    DocxBlock {
        archive_id: String,
        block_id: String,
        block_text: String,
        highlights: Vec<Range>,
    },
    #[serde(rename = "main_doc_field")]
    MainDocField {
        archive_id: String,
        field_name: String,
        source_text: String,
        highlights: Vec<Range>,
        best_block_id: Option<String>,
        best_block_highlights: Option<Vec<Range>>,
    },
    #[serde(rename = "attachment_name")]
    AttachmentName {
        archive_id: String,
        file_id: String,
        display_name: String,
        highlights: Vec<Range>,
    },
    #[serde(rename = "annotation")]
    Annotation {
        archive_id: String,
        annotation_id: String,
        target_kind: String,
        target_ref: String,
        locator: Value,
        content: String,
        highlights: Vec<Range>,
    },
}

pub fn build_search_text(text: &str) -> String {
    let t = text.trim();
    if t.is_empty() {
        return String::new();
    }
    let mut parts = Vec::new();
    parts.extend(jieba_tokens(t));
    parts.extend(char_ngrams(t, 2));
    parts.extend(char_ngrams(t, 3));
    parts.retain(|s| !s.trim().is_empty());
    parts.join(" ")
}

fn jieba_tokens(text: &str) -> Vec<String> {
    JIEBA
        .cut(text, false)
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn char_ngrams(text: &str, n: usize) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() < n {
        return vec![];
    }
    let mut out = Vec::new();
    for i in 0..=(chars.len() - n) {
        out.push(chars[i..i + n].iter().collect::<String>());
    }
    out
}

fn escape_fts_token(t: &str) -> String {
    let s = t.replace('"', "\"\"");
    // FTS5 MATCH 中用双引号包裹 token，避免特殊字符解析
    format!("\"{s}\"")
}

fn build_match_query(query: &str) -> String {
    let q = query.trim();
    if q.is_empty() {
        return String::new();
    }
    let mut tokens = Vec::new();
    tokens.extend(jieba_tokens(q));
    tokens.extend(char_ngrams(q, 2));
    tokens.extend(char_ngrams(q, 3));
    tokens.retain(|s| !s.trim().is_empty());
    tokens.sort();
    tokens.dedup();
    tokens
        .into_iter()
        .map(|t| escape_fts_token(&t))
        .collect::<Vec<_>>()
        .join(" OR ")
}

#[tauri::command]
pub fn search(
    app: tauri::AppHandle,
    state: State<'_, LibraryRootState>,
    req: SearchRequest,
) -> Result<Vec<SearchResult>, String> {
    // 兼容旧前端：默认 offset=0，只返回 items
    let mut r = req;
    r.offset = Some(r.offset.unwrap_or(0));
    search_paged_impl(&app, &state, r)
        .map(|x| x.items)
        .map_err(db::err_to_string)
}

#[tauri::command]
pub fn search_paged(
    app: tauri::AppHandle,
    state: State<'_, LibraryRootState>,
    req: SearchRequest,
) -> Result<SearchPagedResponse, String> {
    search_paged_impl(&app, &state, req).map_err(db::err_to_string)
}

fn search_paged_impl(
    app: &tauri::AppHandle,
    state: &LibraryRootState,
    req: SearchRequest,
) -> Result<SearchPagedResponse> {
    let root = resolve_library_root(app, state)?;
    db::init_db(app, &root)?;
    let conn = Connection::open(root.join("db.sqlite"))?;

    let limit = req.limit.unwrap_or(50).min(200);
    let offset = req.offset.unwrap_or(0).min(20_000);
    let match_query = build_match_query(&req.query);
    if match_query.is_empty() {
        return Ok(SearchPagedResponse {
            items: vec![],
            has_more: false,
            offset,
            limit,
        });
    }

    let filters = req.filters.unwrap_or(SearchFilters {
        date_from: None,
        date_to: None,
        file_types: None,
    });

    let allowed_archives = filter_archives_by_date(&conn, filters.date_from, filters.date_to)?;
    let allowed_archives_set: Option<HashSet<String>> =
        if filters.date_from.is_some() || filters.date_to.is_some() {
            Some(allowed_archives.into_iter().collect())
        } else {
            None
        };

    let want_types: Option<HashSet<String>> = filters
        .file_types
        .map(|v| v.into_iter().collect::<HashSet<_>>());

    // 为分页做过取：至少要拿到 offset+limit 之后还能判断 has_more
    let need = offset.saturating_add(limit).saturating_add(1);
    let fetch = (need.saturating_mul(4)).min(5000).max(200);

    let mut results_docx = query_docx_blocks(&conn, &match_query, fetch, &allowed_archives_set)?;
    let mut results_field = query_main_doc_fields(&conn, &match_query, fetch, &allowed_archives_set)?;
    let mut results_attach =
        query_attachment_names(&conn, &match_query, fetch, &allowed_archives_set, &want_types)?;
    let mut results_anno = query_annotations(&conn, &match_query, fetch, &allowed_archives_set, &want_types)?;

    // 计算 highlights
    for r in results_docx.iter_mut() {
        if let SearchResult::DocxBlock { block_text, highlights, .. } = r {
            *highlights = compute_highlights_utf16(block_text, &req.query);
        }
    }
    for r in results_attach.iter_mut() {
        if let SearchResult::AttachmentName { display_name, highlights, .. } = r {
            *highlights = compute_highlights_utf16(display_name, &req.query);
        }
    }
    for r in results_anno.iter_mut() {
        if let SearchResult::Annotation { content, highlights, .. } = r {
            *highlights = compute_highlights_utf16(content, &req.query);
        }
    }

    // main_doc_field：计算高亮，并对 content 计算 best_block_id
    let mut content_block_map: HashMap<String, Vec<String>> = HashMap::new();
    {
        let mut stmt = conn.prepare("SELECT archive_id, field_block_map_json FROM main_doc")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        for row in rows {
            let (archive_id, map_json) = row?;
            let v: Value = serde_json::from_str(&map_json).unwrap_or(serde_json::json!({}));
            let content_ids = v
                .get("content")
                .and_then(|c| c.as_array())
                .map(|arr| arr.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect::<Vec<_>>())
                .unwrap_or_default();
            if !content_ids.is_empty() {
                content_block_map.insert(archive_id, content_ids);
            }
        }
    }

    // 收集 docx 命中的 (archive_id, block_id) 用于 content 去重
    let mut docx_hit_blocks: HashSet<(String, String)> = HashSet::new();
    for r in &results_docx {
        if let SearchResult::DocxBlock { archive_id, block_id, .. } = r {
            docx_hit_blocks.insert((archive_id.clone(), block_id.clone()));
        }
    }

    let query_tokens = {
        let mut tokens = Vec::new();
        tokens.extend(jieba_tokens(req.query.trim()));
        tokens.extend(char_ngrams(req.query.trim(), 2));
        tokens.extend(char_ngrams(req.query.trim(), 3));
        tokens.retain(|s| !s.trim().is_empty());
        tokens.sort();
        tokens.dedup();
        tokens
    };

    let mut filtered_field_results = Vec::new();
    for mut r in results_field.into_iter() {
        if let SearchResult::MainDocField {
            archive_id,
            field_name,
            source_text,
            highlights,
            best_block_id,
            best_block_highlights,
        } = &mut r
        {
            *highlights = compute_highlights_utf16(source_text, &req.query);
            if field_name == "content" {
                // 去重：若 docx_blocks 已命中 content 区间内某段落，字段命中可以折叠（这里直接丢弃）
                if let Some(content_ids) = content_block_map.get(archive_id) {
                    let mut has_overlap = false;
                    for bid in content_ids {
                        if docx_hit_blocks.contains(&(archive_id.clone(), bid.clone())) {
                            has_overlap = true;
                            break;
                        }
                    }
                    if has_overlap {
                        continue;
                    }

                    // best_block_id：在 content_block_ids 中选择最相关段落
                    if let Some((best_id, best_text)) =
                        pick_best_content_block(&conn, archive_id, content_ids, &query_tokens)?
                    {
                        *best_block_id = Some(best_id.clone());
                        *best_block_highlights = Some(compute_highlights_utf16(&best_text, &req.query));
                    } else if let Some(first) = content_ids.first() {
                        *best_block_id = Some(first.clone());
                    }
                }
            }
        }
        filtered_field_results.push(r);
    }
    results_field = filtered_field_results;

    // 类型过滤：docx_main / main_doc_field 属于 docx_main，附件按 file_type 过滤已在 SQL 内做；这里再做总过滤
    if let Some(want) = want_types.clone() {
        let want_docx = want.contains("docx_main");
        results_docx.retain(|_| want_docx);
        results_field.retain(|_| want_docx);
    }

    // 排序与合并：docx_block > main_doc_field > attachment_name
    let mut out = Vec::new();
    out.extend(results_docx);
    out.extend(results_field);
    out.extend(results_anno);
    out.extend(results_attach);

    // 简单排序：按 kind + 命中长度（highlights 覆盖总长度）
    out.sort_by(|a, b| {
        let ka = kind_rank(a);
        let kb = kind_rank(b);
        if ka != kb {
            return ka.cmp(&kb);
        }
        if let (
            SearchResult::MainDocField { field_name: fa, .. },
            SearchResult::MainDocField { field_name: fb, .. },
        ) = (a, b)
        {
            let ra = field_rank(fa);
            let rb = field_rank(fb);
            if ra != rb {
                return ra.cmp(&rb);
            }
        }
        let sa = highlight_score(a);
        let sb = highlight_score(b);
        sb.cmp(&sa)
    });

    let has_more = out.len() > offset.saturating_add(limit);
    let items = out
        .into_iter()
        .skip(offset)
        .take(limit)
        .collect::<Vec<_>>();

    Ok(SearchPagedResponse {
        items,
        has_more,
        offset,
        limit,
    })
}

fn kind_rank(r: &SearchResult) -> i32 {
    match r {
        SearchResult::DocxBlock { .. } => 0,
        SearchResult::MainDocField { .. } => 1,
        SearchResult::Annotation { .. } => 2,
        SearchResult::AttachmentName { .. } => 3,
    }
}

fn highlight_score(r: &SearchResult) -> usize {
    let hs = match r {
        SearchResult::DocxBlock { highlights, .. } => highlights,
        SearchResult::MainDocField { highlights, .. } => highlights,
        SearchResult::Annotation { highlights, .. } => highlights,
        SearchResult::AttachmentName { highlights, .. } => highlights,
    };
    hs.iter().map(|x| x.end.saturating_sub(x.start)).sum()
}

fn field_rank(field_name: &str) -> i32 {
    match field_name {
        "instruction_no" => 0,
        "title" => 1,
        "content" => 2,
        "issued_at" => 3,
        _ => 9,
    }
}

fn filter_archives_by_date(conn: &Connection, from: Option<i64>, to: Option<i64>) -> Result<Vec<String>> {
    if from.is_none() && to.is_none() {
        return Ok(vec![]);
    }
    let from_v = from.unwrap_or(i64::MIN);
    let to_v = to.unwrap_or(i64::MAX);
    let mut stmt = conn.prepare("SELECT archive_id FROM archives WHERE zip_date BETWEEN ? AND ?")?;
    let rows = stmt.query_map(params![from_v, to_v], |r| r.get::<_, String>(0))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

fn query_docx_blocks(
    conn: &Connection,
    match_query: &str,
    limit: usize,
    allowed_archives: &Option<HashSet<String>>,
) -> Result<Vec<SearchResult>> {
    let mut out = Vec::new();
    let sql = "SELECT archive_id, block_id, source_text FROM docx_blocks_fts WHERE docx_blocks_fts MATCH ? LIMIT ?";
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(params![match_query, limit as i64], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })?;
    for row in rows {
        let (archive_id, block_id, block_text) = row?;
        if let Some(set) = allowed_archives {
            if !set.contains(&archive_id) {
                continue;
            }
        }
        out.push(SearchResult::DocxBlock {
            archive_id,
            block_id,
            block_text,
            highlights: vec![],
        });
        if out.len() >= limit {
            break;
        }
    }
    Ok(out)
}

fn query_main_doc_fields(
    conn: &Connection,
    match_query: &str,
    limit: usize,
    allowed_archives: &Option<HashSet<String>>,
) -> Result<Vec<SearchResult>> {
    let mut out = Vec::new();
    let sql = "SELECT archive_id, field_name, source_text FROM main_doc_fts WHERE main_doc_fts MATCH ? LIMIT ?";
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(params![match_query, limit as i64], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })?;
    for row in rows {
        let (archive_id, field_name, source_text) = row?;
        if let Some(set) = allowed_archives {
            if !set.contains(&archive_id) {
                continue;
            }
        }
        out.push(SearchResult::MainDocField {
            archive_id,
            field_name,
            source_text,
            highlights: vec![],
            best_block_id: None,
            best_block_highlights: None,
        });
        if out.len() >= limit {
            break;
        }
    }
    Ok(out)
}

fn query_attachment_names(
    conn: &Connection,
    match_query: &str,
    limit: usize,
    allowed_archives: &Option<HashSet<String>>,
    want_types: &Option<HashSet<String>>,
) -> Result<Vec<SearchResult>> {
    let mut out = Vec::new();

    // 根据 want_types 过滤 attachment file_type
    let mut type_clause = String::new();
    let mut type_params: Vec<String> = Vec::new();
    if let Some(want) = want_types {
        let attachment_types: Vec<String> = want
            .iter()
            .filter(|t| *t != "docx_main")
            .cloned()
            .collect();
        if attachment_types.is_empty() {
            return Ok(vec![]);
        }
        type_clause = format!(
            " AND a.file_type IN ({})",
            attachment_types.iter().map(|_| "?").collect::<Vec<_>>().join(",")
        );
        type_params = attachment_types;
    }

    // allowed_archives 过滤
    let mut archive_clause = String::new();
    let mut archive_params: Vec<String> = Vec::new();
    if let Some(set) = allowed_archives {
        if set.is_empty() {
            return Ok(vec![]);
        }
        archive_clause = format!(
            " AND a.archive_id IN ({})",
            set.iter().map(|_| "?").collect::<Vec<_>>().join(",")
        );
        archive_params = set.iter().cloned().collect();
    }

    let sql = format!(
        "SELECT a.archive_id, a.file_id, attachments_fts.display_name
         FROM attachments_fts
         JOIN attachments a ON a.file_id=attachments_fts.file_id
         WHERE attachments_fts MATCH ? {type_clause} {archive_clause}
         LIMIT ?"
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut bind: Vec<rusqlite::types::Value> = Vec::new();
    bind.push(rusqlite::types::Value::from(match_query.to_string()));
    for t in type_params {
        bind.push(rusqlite::types::Value::from(t));
    }
    for a in archive_params {
        bind.push(rusqlite::types::Value::from(a));
    }
    bind.push(rusqlite::types::Value::from(limit as i64));

    let rows = stmt.query_map(rusqlite::params_from_iter(bind), |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })?;
    for row in rows {
        let (archive_id, file_id, display_name) = row?;
        out.push(SearchResult::AttachmentName {
            archive_id,
            file_id,
            display_name,
            highlights: vec![],
        });
        if out.len() >= limit {
            break;
        }
    }
    Ok(out)
}

fn query_annotations(
    conn: &Connection,
    match_query: &str,
    limit: usize,
    allowed_archives: &Option<HashSet<String>>,
    want_types: &Option<HashSet<String>>,
) -> Result<Vec<SearchResult>> {
    if let Some(want) = want_types {
        if !want.contains("annotation") {
            return Ok(vec![]);
        }
    }

    // allowed_archives 过滤
    let mut archive_clause = String::new();
    let mut archive_params: Vec<String> = Vec::new();
    if let Some(set) = allowed_archives {
        if set.is_empty() {
            return Ok(vec![]);
        }
        archive_clause = format!(
            " AND a.archive_id IN ({})",
            set.iter().map(|_| "?").collect::<Vec<_>>().join(",")
        );
        archive_params = set.iter().cloned().collect();
    }

    let sql = format!(
        "SELECT a.archive_id, a.annotation_id, a.target_kind, a.target_ref, a.locator_json, a.content
         FROM annotations_fts
         JOIN annotations a ON a.annotation_id=annotations_fts.annotation_id
         WHERE annotations_fts MATCH ? {archive_clause}
         LIMIT ?"
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut bind: Vec<rusqlite::types::Value> = Vec::new();
    bind.push(rusqlite::types::Value::from(match_query.to_string()));
    for a in archive_params {
        bind.push(rusqlite::types::Value::from(a));
    }
    bind.push(rusqlite::types::Value::from(limit as i64));
    let rows = stmt.query_map(rusqlite::params_from_iter(bind), |r| {
        let locator_json: String = r.get(4)?;
        let locator: Value = serde_json::from_str(&locator_json).unwrap_or(serde_json::json!({}));
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            locator,
            r.get::<_, String>(5)?,
        ))
    })?;

    let mut out = Vec::new();
    for row in rows {
        let (archive_id, annotation_id, target_kind, target_ref, locator, content) = row?;
        out.push(SearchResult::Annotation {
            archive_id,
            annotation_id,
            target_kind,
            target_ref,
            locator,
            content,
            highlights: vec![],
        });
        if out.len() >= limit {
            break;
        }
    }
    Ok(out)
}

fn compute_highlights_utf16(text: &str, query: &str) -> Vec<Range> {
    let q = query.trim();
    if q.is_empty() || text.is_empty() {
        return vec![];
    }
    let mut needles = Vec::new();
    // 先用原始 query（去掉多余空白）
    let q2 = q.split_whitespace().collect::<String>();
    if !q2.is_empty() {
        needles.push(q2);
    }
    // 分词与 ngram
    needles.extend(jieba_tokens(q));
    needles.extend(char_ngrams(q, 2));
    needles.extend(char_ngrams(q, 3));
    needles.retain(|s| !s.trim().is_empty());
    needles.sort();
    needles.dedup();

    let mut ranges = Vec::new();
    for n in needles {
        for (byte_start, _) in text.match_indices(&n) {
            let byte_end = byte_start + n.len();
            if let (Some(us), Some(ue)) = (byte_to_utf16(text, byte_start), byte_to_utf16(text, byte_end)) {
                if us < ue {
                    ranges.push(Range { start: us, end: ue });
                }
            }
        }
    }
    normalize_ranges(ranges, 20)
}

fn byte_to_utf16(text: &str, byte_idx: usize) -> Option<usize> {
    if byte_idx > text.len() {
        return None;
    }
    // byte_idx 必须在 char 边界上；match_indices 的 byte_start 总在边界上
    let mut utf16 = 0usize;
    let mut last_byte = 0usize;
    for (b, ch) in text.char_indices() {
        if b >= byte_idx {
            return Some(utf16);
        }
        utf16 += ch.len_utf16();
        last_byte = b;
    }
    if byte_idx == text.len() {
        // 末尾
        return Some(text.encode_utf16().count());
    }
    // 非边界
    if last_byte < byte_idx {
        None
    } else {
        Some(utf16)
    }
}

fn normalize_ranges(mut ranges: Vec<Range>, max: usize) -> Vec<Range> {
    if ranges.is_empty() {
        return vec![];
    }
    ranges.sort_by(|a, b| (a.start, a.end).cmp(&(b.start, b.end)));
    let mut merged = Vec::new();
    let mut cur = ranges[0].clone();
    for r in ranges.into_iter().skip(1) {
        if r.start <= cur.end {
            cur.end = cur.end.max(r.end);
        } else {
            merged.push(cur);
            cur = r;
        }
    }
    merged.push(cur);
    merged.truncate(max);
    merged
}

fn pick_best_content_block(
    conn: &Connection,
    archive_id: &str,
    content_block_ids: &[String],
    tokens: &[String],
) -> Result<Option<(String, String)>> {
    if content_block_ids.is_empty() {
        return Ok(None);
    }
    // 读取这些段落文本
    let mut texts: Vec<(String, String)> = Vec::new();
    let mut stmt = conn.prepare("SELECT block_id,text FROM docx_blocks WHERE archive_id=? AND block_id=?")?;
    for bid in content_block_ids {
        if let Some((block_id, text)) = stmt
            .query_row(params![archive_id, bid], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .optional()?
        {
            texts.push((block_id, text));
        }
    }
    if texts.is_empty() {
        return Ok(None);
    }

    let mut best: Option<(String, String, i64)> = None;
    for (bid, text) in texts {
        let mut score = 0i64;
        for t in tokens {
            if t.is_empty() {
                continue;
            }
            score += text.matches(t).count() as i64;
        }
        if best.as_ref().map(|b| score > b.2).unwrap_or(true) {
            best = Some((bid, text, score));
        }
    }
    Ok(best.map(|(bid, text, _)| (bid, text)))
}
