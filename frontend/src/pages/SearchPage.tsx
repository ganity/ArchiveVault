import { useEffect, useMemo, useState } from "react";
import { invoke } from "../tauri";
import TextHighlighter from "./components/TextHighlighter";

type SearchResult =
  | {
    kind: "docx_block";
    archive_id: string;
    block_id: string;
    block_text: string;
    highlights: { start: number; end: number }[];
  }
  | {
    kind: "main_doc_field";
    archive_id: string;
    field_name: string;
    source_text: string;
    highlights: { start: number; end: number }[];
    best_block_id?: string | null;
    best_block_highlights?: { start: number; end: number }[] | null;
  }
  | {
    kind: "attachment_name";
    archive_id: string;
    file_id: string;
    display_name: string;
    highlights: { start: number; end: number }[];
  }
  | {
    kind: "annotation";
    archive_id: string;
    annotation_id: string;
    target_kind: string;
    target_ref: string;
    locator: any;
    content: string;
    highlights: { start: number; end: number }[];
  };

type SearchFilters = {
  date_from?: number | null;
  date_to?: number | null;
  file_types?: string[] | null;
};

type SearchPagedResponse = {
  items: SearchResult[];
  has_more: boolean;
  offset: number;
  limit: number;
};

type ArchiveListItem = {
  archive_id: string;
  original_name: string;
  zip_date: number;
  imported_at: number;
  status: string;
  instruction_no?: string | null;
  title?: string | null;
  content?: string | null;
};

type FileTypeKey =
  | "docx_main"
  | "annotation"
  | "pdf"
  | "excel"
  | "image"
  | "video"
  | "docx_other"
  | "other"
  | "zip_child";

type KeywordSuggestion = {
  keyword: string;
  count: number;
};

export default function SearchPage({
  onOpenArchive,
  refreshToken,
}: {
  onOpenArchive: (
    archiveId: string,
    open:
      | { kind: "docx"; block_id?: string; highlights?: { start: number; end: number }[]; field_name?: string; field_highlights?: { start: number; end: number }[] }
      | { kind: "attachment"; file_id: string; highlights?: { start: number; end: number }[]; display_name?: string }
      | { kind: "annotation"; annotation_id: string }
      | null
  ) => void;
  refreshToken?: number;
}) {
  const [query, setQuery] = useState("");
  const [msg, setMsg] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searchOffset, setSearchOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [searching, setSearching] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const [archives, setArchives] = useState<ArchiveListItem[]>([]);
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");

  // 标题编辑状态
  const [editingArchiveId, setEditingArchiveId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState<string>("");
  const [saving, setSaving] = useState(false);

  // 指令内容展开状态
  const [expandedContent, setExpandedContent] = useState<Record<string, boolean>>({});

  const [typeSel, setTypeSel] = useState<Record<FileTypeKey, boolean>>({
    docx_main: true,
    annotation: true,
    pdf: true,
    excel: true,
    image: true,
    video: true,
    docx_other: true,
    other: true,
    zip_child: true,
  });

  // 历史搜索和推荐关键词
  const [searchHistory, setSearchHistory] = useState<string[]>([]);
  const [popularKeywords, setPopularKeywords] = useState<KeywordSuggestion[]>([]);
  const [loadingKeywords, setLoadingKeywords] = useState(false);

  const filters: SearchFilters = useMemo(() => {
    const file_types = (Object.entries(typeSel) as [FileTypeKey, boolean][])
      .filter(([, v]) => v)
      .map(([k]) => k);
    return {
      date_from: toTsStart(dateFrom),
      date_to: toTsEnd(dateTo),
      file_types,
    };
  }, [dateFrom, dateTo, typeSel]);

  const archiveById = useMemo(() => {
    const m = new Map<string, ArchiveListItem>();
    for (const a of archives) m.set(a.archive_id, a);
    return m;
  }, [archives]);

  useEffect(() => {
    // 仅用于丰富搜索结果标题展示（不在UI中展示档案列表）
    invoke<ArchiveListItem[]>("list_archives", {
      req: { date_from: null, date_to: null, limit: 2000, offset: 0 },
    })
      .then(setArchives)
      .catch(() => { });
  }, []);

  useEffect(() => {
    // 日期过滤变化时刷新 meta（用于标题展示）
    invoke<ArchiveListItem[]>("list_archives", {
      req: { date_from: filters.date_from ?? null, date_to: filters.date_to ?? null, limit: 2000, offset: 0 },
    })
      .then(setArchives)
      .catch(() => { });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateFrom, dateTo]);

  useEffect(() => {
    // 档案被删除/重新导入后，刷新结果避免点击到已不存在的 archive_id
    invoke<ArchiveListItem[]>("list_archives", {
      req: { date_from: filters.date_from ?? null, date_to: filters.date_to ?? null, limit: 2000, offset: 0 },
    })
      .then(setArchives)
      .catch(() => { });
    if (query.trim()) {
      runSearch(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  // 加载历史搜索
  useEffect(() => {
    try {
      const history = localStorage.getItem("searchHistory");
      if (history) {
        setSearchHistory(JSON.parse(history));
      }
    } catch (e) {
      console.error("加载历史搜索失败:", e);
    }
  }, []);

  // 加载推荐关键词
  useEffect(() => {
    const loadPopularKeywords = async () => {
      try {
        setLoadingKeywords(true);
        const keywords = await invoke<KeywordSuggestion[]>("get_popular_keywords", { limit: 10 });
        setPopularKeywords(keywords);
      } catch (e) {
        console.error("加载推荐关键词失败:", e);
      } finally {
        setLoadingKeywords(false);
      }
    };
    loadPopularKeywords();
  }, []);

  const groupedResults = useMemo(() => {
    const groups = new Map<
      string,
      {
        archive_id: string;
        first_idx: number;
        docx_blocks: Extract<SearchResult, { kind: "docx_block" }>[];
        fields: Extract<SearchResult, { kind: "main_doc_field" }>[];
        annotations: Extract<SearchResult, { kind: "annotation" }>[];
        attachments: Extract<SearchResult, { kind: "attachment_name" }>[];
      }
    >();

    results.forEach((r, idx) => {
      const g =
        groups.get(r.archive_id) ??
        {
          archive_id: r.archive_id,
          first_idx: idx,
          docx_blocks: [],
          fields: [],
          annotations: [],
          attachments: [],
        };
      g.first_idx = Math.min(g.first_idx, idx);
      if (r.kind === "docx_block") g.docx_blocks.push(r);
      else if (r.kind === "main_doc_field") g.fields.push(r);
      else if (r.kind === "annotation") g.annotations.push(r);
      else g.attachments.push(r);
      groups.set(r.archive_id, g);
    });

    const out = Array.from(groups.values());
    out.sort((a, b) => a.first_idx - b.first_idx);
    for (const g of out) {
      g.docx_blocks.sort((x, y) => blockOrder(x.block_id) - blockOrder(y.block_id));
      g.fields.sort((x, y) => fieldRank(x.field_name) - fieldRank(y.field_name));
      g.annotations.sort((x, y) => (y.content?.length ?? 0) - (x.content?.length ?? 0));
      g.attachments.sort((x, y) => x.display_name.localeCompare(y.display_name, "zh-Hans-CN"));
    }
    return out;
  }, [results]);

  const groupedCards = useMemo(() => {
    return groupedResults.map((g) => {
      const total_hits = g.docx_blocks.length + g.fields.length + g.annotations.length + g.attachments.length;

      const candidates: {
        key: string;
        tag: string;
        text: string;
        ranges: { start: number; end: number }[];
        r: SearchResult;
        order: number;
      }[] = [];

      const docxSorted = [...g.docx_blocks].sort((x, y) => blockOrder(x.block_id) - blockOrder(y.block_id));
      const attSorted = [...g.attachments].sort((x, y) => x.display_name.localeCompare(y.display_name, "zh-Hans-CN"));
      const fieldSorted = [...g.fields].sort((x, y) => fieldRank(x.field_name) - fieldRank(y.field_name));
      const annoSorted = [...g.annotations];

      if (docxSorted.length) {
        for (const r of docxSorted) {
          const sn = makeSnippet(r.block_text, r.highlights);
          candidates.push({
            key: `docx:${r.block_id}`,
            tag: "摘要",
            text: sn.text,
            ranges: sn.ranges,
            r,
            order: blockOrder(r.block_id),
          });
        }
      } else {
        for (const r of fieldSorted) {
          const sn = makeSnippet(r.source_text, r.highlights);
          candidates.push({
            key: `field:${r.field_name}`,
            tag: "摘要",
            text: sn.text,
            ranges: sn.ranges,
            r,
            order: 1_000_000 + fieldRank(r.field_name),
          });
        }
      }

      for (const r of attSorted) {
        candidates.push({
          key: `att:${r.file_id}`,
          tag: "附件名",
          text: r.display_name,
          ranges: r.highlights,
          r,
          order: 2_000_000,
        });
      }

      for (const r of annoSorted) {
        const sn = makeSnippet(r.content, r.highlights, 10, 80);
        candidates.push({
          key: `anno:${r.annotation_id}`,
          tag: "批注",
          text: sn.text,
          ranges: sn.ranges,
          r,
          order: 1_500_000,
        });
      }

      const unique: typeof candidates = [];
      const seen = new Set<string>();
      candidates.sort((a, b) => a.order - b.order);
      for (const c of candidates) {
        const norm = normalizeForDedupe(c.text);
        if (!norm) continue;
        if (seen.has(norm)) continue;
        seen.add(norm);
        unique.push(c);
      }

      return {
        archive_id: g.archive_id,
        total_hits,
        docx_hits: g.docx_blocks.length,
        field_hits: g.fields.length,
        annotation_hits: g.annotations.length,
        attach_hits: g.attachments.length,
        snippets: unique,
      };
    });
  }, [groupedResults]);

  async function runSearch(reset: boolean) {
    setMsg("");
    if (!query.trim()) {
      setResults([]);
      setSearchOffset(0);
      setHasMore(false);
      return;
    }

    // 保存到历史搜索
    if (reset) {
      try {
        const trimmedQuery = query.trim();
        const newHistory = [trimmedQuery, ...searchHistory.filter(h => h !== trimmedQuery)].slice(0, 10);
        setSearchHistory(newHistory);
        localStorage.setItem("searchHistory", JSON.stringify(newHistory));
      } catch (e) {
        console.error("保存历史搜索失败:", e);
      }
    }

    try {
      setSearching(true);
      const nextOffset = reset ? 0 : searchOffset;
      const pageSize = 60;
      const res = await invoke<SearchPagedResponse>("search_paged", {
        req: { query, filters, limit: pageSize, offset: nextOffset },
      });
      setHasMore(res.has_more);
      setSearchOffset(nextOffset + res.items.length);
      setResults((prev) => (reset ? res.items : [...prev, ...res.items]));
    } catch (e: any) {
      setMsg(String(e?.message ?? e));
    } finally {
      setSearching(false);
    }
  }

  async function saveTitle(archiveId: string) {
    if (!editingTitle.trim()) {
      setMsg("标题不能为空");
      return;
    }
    try {
      setSaving(true);
      await invoke("update_archive_title", {
        archiveId,
        newTitle: editingTitle.trim(),
      });
      // 更新本地缓存
      setArchives((prev) =>
        prev.map((a) =>
          a.archive_id === archiveId
            ? { ...a, title: editingTitle.trim() }
            : a
        )
      );
      setEditingArchiveId(null);
      setEditingTitle("");
    } catch (e: any) {
      setMsg(String(e?.message ?? e));
    } finally {
      setSaving(false);
    }
  }

  function startEditing(archiveId: string, currentTitle: string) {
    setEditingArchiveId(archiveId);
    setEditingTitle(currentTitle || "");
  }

  function cancelEditing() {
    setEditingArchiveId(null);
    setEditingTitle("");
  }


  function openResult(r: SearchResult) {
    if (r.kind === "docx_block") {
      onOpenArchive(r.archive_id, { kind: "docx", block_id: r.block_id, highlights: r.highlights });
    } else if (r.kind === "main_doc_field") {
      if (r.best_block_id) {
        onOpenArchive(r.archive_id, {
          kind: "docx",
          block_id: r.best_block_id,
          highlights: r.best_block_highlights ?? r.highlights,
        });
      } else {
        onOpenArchive(r.archive_id, { kind: "docx", field_name: r.field_name, field_highlights: r.highlights });
      }
    } else {
      if (r.kind === "annotation") {
        onOpenArchive(r.archive_id, { kind: "annotation", annotation_id: r.annotation_id });
      } else {
        onOpenArchive(r.archive_id, { kind: "attachment", file_id: r.file_id, highlights: r.highlights, display_name: r.display_name });
      }
    }
  }

  return (
    <div style={{ height: "100%", overflow: "auto", padding: "40px 20px", background: "var(--bg-color)" }}>
      <div style={{ maxWidth: 900, margin: "0 auto" }}>
        <div style={{ display: "grid", gap: 24 }}>
          <div
            className="card"
            style={{
              padding: "24px",
              display: "flex",
              flexDirection: "column",
              gap: 20,
              boxShadow: "0 4px 20px rgba(0,0,0,0.06)",
              border: "none"
            }}
          >
            <div style={{ display: "flex", gap: 12 }}>
              <div style={{ position: "relative", flex: 1 }}>
                <input
                  style={{
                    width: "100%",
                    padding: "14px 18px",
                    paddingLeft: 44,
                    borderRadius: 12,
                    fontSize: 16,
                    border: "1px solid var(--border-color)",
                    background: "#fdfdfd"
                  }}
                  placeholder="搜索主文档内容、字段或附件名称..."
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") runSearch(true);
                  }}
                />
                <span style={{ position: "absolute", left: 16, top: "50%", transform: "translateY(-50%)", fontSize: 18, opacity: 0.5 }}>🔍</span>
              </div>
              <button
                className="primary"
                onClick={() => runSearch(true)}
                disabled={searching}
                style={{ padding: "0 32px", height: 52, borderRadius: 12, fontSize: 15, fontWeight: 600 }}
              >
                {searching ? "搜索中..." : "搜索"}
              </button>
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 24, padding: "4px 0" }}>
              <div style={{ display: "flex", gap: 16 }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase" }}>日期从</span>
                  <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} style={{ padding: "6px 8px", fontSize: 12 }} />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase" }}>到</span>
                  <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={{ padding: "6px 8px", fontSize: 12 }} />
                </label>
              </div>

              <div style={{ flex: 1 }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", display: "block", marginBottom: 8 }}>文件类型</span>
                <div style={{ display: "flex", gap: "8px 16px", flexWrap: "wrap" }}>
                  {renderTypeToggle("主文档", "docx_main", typeSel, setTypeSel)}
                  {renderTypeToggle("批注", "annotation", typeSel, setTypeSel)}
                  {renderTypeToggle("PDF", "pdf", typeSel, setTypeSel)}
                  {renderTypeToggle("Excel", "excel", typeSel, setTypeSel)}
                  {renderTypeToggle("图片", "image", typeSel, setTypeSel)}
                  {renderTypeToggle("视频", "video", typeSel, setTypeSel)}
                  {renderTypeToggle("附加docx", "docx_other", typeSel, setTypeSel)}
                  {renderTypeToggle("子ZIP", "zip_child", typeSel, setTypeSel)}
                  {renderTypeToggle("其它", "other", typeSel, setTypeSel)}
                </div>
              </div>
            </div>

          </div>
        </div>

        <div style={{ marginTop: 24, display: "grid", gap: 16 }}>
          {groupedCards.map((g) => {
            const meta = archiveById.get(g.archive_id);
            const isExpanded = Boolean(expanded[g.archive_id]);
            const showCount = isExpanded ? 5 : 1;
            return (
              <div key={g.archive_id} className="card animate-fade-in" style={{ padding: 0, overflow: "hidden" }}>
                <div
                  className="search-result-header"
                  onClick={(e) => {
                    if (editingArchiveId !== g.archive_id) {
                      onOpenArchive(g.archive_id, { kind: "docx" });
                    }
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start" }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      {editingArchiveId === g.archive_id ? (
                        <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                          <input
                            type="text"
                            value={editingTitle}
                            onChange={(e) => setEditingTitle(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") saveTitle(g.archive_id);
                              if (e.key === "Escape") cancelEditing();
                            }}
                            autoFocus
                            style={{
                              flex: 1,
                              padding: "8px 12px",
                              fontSize: 15,
                              fontWeight: 600,
                              border: "2px solid var(--primary-color)",
                              borderRadius: 8,
                              outline: "none"
                            }}
                          />
                          <button
                            onClick={() => saveTitle(g.archive_id)}
                            disabled={saving}
                            style={{
                              padding: "8px 16px",
                              background: "var(--primary-color)",
                              color: "white",
                              border: "none",
                              borderRadius: 8,
                              cursor: saving ? "not-allowed" : "pointer",
                              fontSize: 13,
                              fontWeight: 600
                            }}
                          >
                            {saving ? "保存中..." : "保存"}
                          </button>
                          <button
                            onClick={cancelEditing}
                            disabled={saving}
                            style={{
                              padding: "8px 16px",
                              background: "#e2e8f0",
                              color: "#475569",
                              border: "none",
                              borderRadius: 8,
                              cursor: saving ? "not-allowed" : "pointer",
                              fontSize: 13
                            }}
                          >
                            取消
                          </button>
                        </div>
                      ) : (
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <div className="search-result-title">
                            {meta?.title || meta?.original_name || g.archive_id}
                          </div>
                          {meta?.title && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                startEditing(g.archive_id, meta.title || "");
                              }}
                              style={{
                                padding: "4px 8px",
                                background: "transparent",
                                border: "1px solid var(--border-color)",
                                borderRadius: 6,
                                cursor: "pointer",
                                fontSize: 12,
                                color: "var(--text-muted)",
                                opacity: 0.7,
                                transition: "all 0.2s"
                              }}
                              onMouseEnter={(e) => {
                                e.currentTarget.style.opacity = "1";
                                e.currentTarget.style.backgroundColor = "#f1f5f9";
                              }}
                              onMouseLeave={(e) => {
                                e.currentTarget.style.opacity = "0.7";
                                e.currentTarget.style.backgroundColor = "transparent";
                              }}
                              title="编辑标题"
                            >
                              ✏️
                            </button>
                          )}
                        </div>
                      )}
                      <div style={{ display: "flex", gap: 12, marginTop: 6, fontSize: 12, color: "var(--text-muted)" }}>
                        {meta?.instruction_no && (
                          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                            <span style={{ opacity: 0.5 }}>#</span> {meta.instruction_no}
                          </span>
                        )}
                        <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                          <span style={{ opacity: 0.5 }}>📍</span> {g.total_hits} 条命中
                        </span>
                      </div>
                      {/* 指令内容 */}
                      {meta?.content && (
                        <div style={{
                          marginTop: 12,
                          padding: "10px 12px",
                          background: "#f8fafc",
                          borderRadius: 8,
                          fontSize: 13,
                          color: "var(--text-main)",
                          lineHeight: 1.6,
                          borderTop: "1px solid var(--border-color)"
                        }}>
                          <div style={{
                            fontSize: 11,
                            fontWeight: 600,
                            color: "var(--text-muted)",
                            marginBottom: 6,
                            textTransform: "uppercase"
                          }}>
                            指令内容
                          </div>
                          <div style={{
                            display: expandedContent[g.archive_id] ? "block" : "-webkit-box",
                            WebkitLineClamp: expandedContent[g.archive_id] ? "unset" : 3,
                            WebkitBoxOrient: "vertical",
                            overflow: "hidden",
                            textOverflow: "ellipsis"
                          }}>
                            {meta.content}
                          </div>
                          {meta.content.length > 100 && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setExpandedContent(prev => ({
                                  ...prev,
                                  [g.archive_id]: !prev[g.archive_id]
                                }));
                              }}
                              style={{
                                marginTop: 8,
                              padding: "4px 8px",
                              background: "none",
                              border: "none",
                              color: "var(--primary-color)",
                              fontSize: 12,
                              cursor: "pointer",
                              fontWeight: 500
                            }}
                            >
                              {expandedContent[g.archive_id] ? "收起 ▲" : "展开全部 ↓"}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <div style={{ padding: 12, display: "grid", gap: 8 }}>
                  {g.snippets.slice(0, showCount).map((s) => (
                    <button
                      key={s.key}
                      onClick={() => openResult(s.r)}
                      style={{
                        textAlign: "left",
                        padding: "12px 14px",
                        border: "1px solid transparent",
                        borderRadius: 10,
                        background: "#f8fafc",
                        cursor: "pointer",
                        transition: "all 0.2s",
                        fontFamily: "inherit"
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor = "#f1f5f9";
                        e.currentTarget.style.borderColor = "#e2e8f0";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = "#f8fafc";
                        e.currentTarget.style.borderColor = "transparent";
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                        <span style={{
                          fontSize: 10,
                          fontWeight: 700,
                          background: "#e2e8f0",
                          color: "#475569",
                          padding: "2px 6px",
                          borderRadius: 4,
                          textTransform: "uppercase"
                        }}>
                          {s.tag}
                        </span>
                      </div>
                      <div style={{ fontSize: 14, color: "var(--text-main)", lineHeight: 1.6 }}>
                        <TextHighlighter text={s.text} ranges={s.ranges} />
                      </div>
                    </button>
                  ))}

                  {g.snippets.length > 1 && (
                    <button
                      onClick={() => setExpanded((p) => ({ ...p, [g.archive_id]: !Boolean(p[g.archive_id]) }))}
                      style={{
                        marginTop: 4,
                        fontSize: 13,
                        color: "var(--primary-color)",
                        border: "none",
                        background: "none",
                        fontWeight: 500,
                        padding: "8px",
                        width: "100%",
                        display: "flex",
                        justifyContent: "center",
                        cursor: "pointer",
                        fontFamily: "inherit"
                      }}
                    >
                      {isExpanded ? "收起" : `展开更多 (${g.snippets.length - 1})`}
                    </button>
                  )}
                </div>
              </div>
            );
          })}

          {query.trim() ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 12, alignItems: "center", padding: "32px 0" }}>
              <button
                disabled={!hasMore || searching}
                onClick={() => runSearch(false)}
                className={hasMore ? "primary" : ""}
                style={{ padding: "10px 32px", fontSize: 14, minWidth: 160 }}
              >
                {hasMore ? (searching ? "加载中..." : "加载更多") : "没有更多了"}
              </button>
              <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
                已显示 {results.length} 条命中 · 跨越 {groupedCards.length} 个档案
              </div>
            </div>
          ) : (
            results.length === 0 && !searching && (
              <div style={{
                padding: "40px 20px",
                background: "white",
                borderRadius: 20,
                border: "1px dashed var(--border-color)"
              }}>
                {/* 历史搜索 */}
                {searchHistory.length > 0 && (
                  <div style={{ marginBottom: 32 }}>
                    <div style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: 16
                    }}>
                      <h3 style={{
                        fontSize: 15,
                        fontWeight: 600,
                        color: "var(--text-main)",
                        margin: 0
                      }}>
                        🕐 历史搜索
                      </h3>
                      <button
                        onClick={() => {
                          setSearchHistory([]);
                          localStorage.removeItem("searchHistory");
                        }}
                        style={{
                          padding: "4px 12px",
                          background: "transparent",
                          border: "1px solid var(--border-color)",
                          borderRadius: 6,
                          fontSize: 12,
                          color: "var(--text-muted)",
                          cursor: "pointer"
                        }}
                      >
                        清空
                      </button>
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                      {searchHistory.map((keyword, idx) => (
                        <button
                          key={idx}
                          onClick={() => {
                            setQuery(keyword);
                            runSearch(true);
                          }}
                          style={{
                            padding: "8px 14px",
                            background: "#f8fafc",
                            border: "1px solid var(--border-color)",
                            borderRadius: 16,
                            fontSize: 13,
                            color: "var(--text-main)",
                            cursor: "pointer",
                            transition: "all 0.2s"
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.background = "#e2e8f0";
                            e.currentTarget.style.borderColor = "#cbd5e1";
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.background = "#f8fafc";
                            e.currentTarget.style.borderColor = "var(--border-color)";
                          }}
                        >
                          {keyword}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* 推荐关键词 */}
                <div>
                  <h3 style={{
                    fontSize: 15,
                    fontWeight: 600,
                    color: "var(--text-main)",
                    marginBottom: 16,
                    marginTop: 0
                  }}>
                    🔥 推荐关键词
                  </h3>
                  {loadingKeywords ? (
                    <div style={{
                      padding: "20px",
                      textAlign: "center",
                      color: "var(--text-muted)",
                      fontSize: 13
                    }}>
                      加载中...
                    </div>
                  ) : popularKeywords.length > 0 ? (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                      {popularKeywords.map((kw, idx) => (
                        <button
                          key={idx}
                          onClick={() => {
                            setQuery(kw.keyword);
                            runSearch(true);
                          }}
                          style={{
                            padding: "8px 14px",
                            background: "#fef3c7",
                            border: "1px solid #fde68a",
                            borderRadius: 16,
                            fontSize: 13,
                            color: "#92400e",
                            cursor: "pointer",
                            transition: "all 0.2s",
                            position: "relative"
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.background = "#fde68a";
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.background = "#fef3c7";
                          }}
                          title={`出现 ${kw.count} 次`}
                        >
                          {kw.keyword}
                          <span style={{
                            marginLeft: 6,
                            fontSize: 11,
                            opacity: 0.7
                          }}>
                            ({kw.count})
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div style={{
                      padding: "20px",
                      textAlign: "center",
                      color: "var(--text-muted)",
                      fontSize: 13
                    }}>
                      暂无推荐关键词
                    </div>
                  )}
                </div>
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}

function renderTypeToggle(
  label: string,
  key: FileTypeKey,
  state: Record<FileTypeKey, boolean>,
  setState: (v: Record<FileTypeKey, boolean>) => void
) {
  return (
    <label key={key} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
      <input type="checkbox" checked={state[key]} onChange={(e) => setState({ ...state, [key]: e.target.checked })} />
      <span>{label}</span>
    </label>
  );
}

function toTsStart(date: string): number | null {
  const d = parseLocalDate(date, false);
  if (!d) return null;
  return Math.floor(d.getTime() / 1000);
}

function toTsEnd(date: string): number | null {
  const d = parseLocalDate(date, true);
  if (!d) return null;
  return Math.floor(d.getTime() / 1000);
}

function parseLocalDate(date: string, endOfDay: boolean): Date | null {
  if (!date) return null;
  const [year, month, day] = date.split("-").map(Number);
  if (![year, month, day].every(Number.isFinite)) return null;
  return endOfDay
    ? new Date(year, month - 1, day, 23, 59, 59, 999)
    : new Date(year, month - 1, day, 0, 0, 0, 0);
}

function blockOrder(blockId: string): number {
  const m = /(\d+)$/.exec(blockId);
  if (!m) return Number.MAX_SAFE_INTEGER;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

function fieldRank(name: string): number {
  if (name === "instruction_no") return 0;
  if (name === "title") return 1;
  if (name === "content") return 2;
  if (name === "issued_at") return 3;
  return 9;
}

function normalizeForDedupe(text: string): string {
  return text
    .replace(/\s+/g, "")
    .replace(/[，。！？；：、“”‘’（）()【】\[\]<>《》\-—_.,!?:;'"`~]/g, "")
    .replace(/指令编号|指令号|编号|指令标题|标题|下发时间|发文时间|指令内容/g, "")
    .slice(0, 160);
}

function makeSnippet(
  text: string,
  ranges: { start: number; end: number }[],
  before: number = 20,
  after: number = 60
): { text: string; ranges: { start: number; end: number }[] } {
  if (!text) return { text: "", ranges: [] };
  if (!ranges?.length) {
    const t = text.length > before + after ? `${text.slice(0, before + after)}…` : text;
    return { text: t, ranges: [] };
  }
  const first = ranges[0];
  const start = Math.max(0, first.start - before);
  const end = Math.min(text.length, first.end + after);
  let snippet = text.slice(start, end);
  let shift = -start;
  if (start > 0) {
    snippet = `…${snippet}`;
    shift += 1;
  }
  if (end < text.length) snippet = `${snippet}…`;
  const clipped = ranges
    .map((r) => ({ start: r.start + shift, end: r.end + shift }))
    .map((r) => ({ start: Math.max(0, r.start), end: Math.min(snippet.length, r.end) }))
    .filter((r) => r.end > r.start);
  return { text: snippet, ranges: clipped };
}
