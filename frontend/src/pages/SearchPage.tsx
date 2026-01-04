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
                  onClick={() => onOpenArchive(g.archive_id, { kind: "docx" })}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start" }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="search-result-title">
                        {meta?.title || meta?.original_name || g.archive_id}
                      </div>
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
                textAlign: "center",
                padding: "80px 20px",
                color: "var(--text-muted)",
                background: "white",
                borderRadius: 20,
                border: "1px dashed var(--border-color)"
              }}>
                <div style={{ fontSize: 40, marginBottom: 16 }}>🔍</div>
                <div style={{ fontSize: 16, fontWeight: 500 }}>开始搜索以查看结果</div>
                <div style={{ fontSize: 13, opacity: 0.7, marginTop: 4 }}>您可以输入关键词搜索全文或特定字段</div>
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
  if (!date) return null;
  const d = new Date(`${date}T00:00:00+08:00`);
  return Math.floor(d.getTime() / 1000);
}

function toTsEnd(date: string): number | null {
  if (!date) return null;
  const d = new Date(`${date}T23:59:59+08:00`);
  return Math.floor(d.getTime() / 1000);
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
