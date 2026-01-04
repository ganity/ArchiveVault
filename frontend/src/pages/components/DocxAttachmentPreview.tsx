import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "../../tauri";
import TextHighlighter from "./TextHighlighter";

type PreviewResp = {
  file_id: string;
  paragraphs: string[];
  image_paths: string[];
};

export default function DocxAttachmentPreview({
  fileId,
  annotations,
  focus,
  onContextMenuCreate,
  onAnnotationClick,
}: {
  fileId: string;
  annotations?: {
    byPage?: Record<number, string[]>;
    byPara?: Record<number, string[]>;
    byImage?: Record<number, string[]>;
  };
  focus?: { page?: number; para_idx?: number; image_index?: number; ranges?: { start: number; end: number }[] } | null;
  onContextMenuCreate?: (req: any, x: number, y: number) => void;
  onAnnotationClick?: (annotationId: string) => void;
}) {
  const [msg, setMsg] = useState("");
  const [data, setData] = useState<PreviewResp | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setMsg("");
    setData(null);
    invoke<PreviewResp>("get_docx_attachment_preview", { fileId })
      .then((r) => {
        if (!cancelled) setData(r);
      })
      .catch((e) => setMsg(String(e?.message ?? e)));
    return () => {
      cancelled = true;
    };
  }, [fileId]);

  const pages = useMemo(() => {
    // paragraphs 内可能包含 \f（分页符），据此做“伪分页”
    const out: { page: number; paras: { para_idx: number; text: string }[] }[] = [];
    let page = 1;
    let cur: { para_idx: number; text: string }[] = [];
    const ps = data?.paragraphs ?? [];
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i] ?? "";
      const parts = p.split("\f");
      for (let j = 0; j < parts.length; j++) {
        const t = parts[j];
        if (t.trim().length) cur.push({ para_idx: i, text: t });
        if (j < parts.length - 1) {
          out.push({ page, paras: cur });
          page += 1;
          cur = [];
        }
      }
    }
    if (cur.length || !out.length) out.push({ page, paras: cur });
    // 限制空页
    return out.filter((x) => x.paras.length > 0);
  }, [data]);

  const imgs = data?.image_paths ?? [];

  useEffect(() => {
    if (!focus) return;
    const id = focus.page
      ? pageAnchorId(fileId, focus.page)
      : typeof focus.para_idx === "number"
        ? paraAnchorId(fileId, focus.para_idx)
        : typeof focus.image_index === "number"
          ? imageAnchorId(fileId, focus.image_index)
          : null;
    if (!id) return;
    setTimeout(() => {
      const el = rootRef.current?.querySelector(`#${cssEscape(id)}`) as HTMLElement | null;
      el?.scrollIntoView({ block: "center" });
    }, 0);
  }, [focus, fileId]);

  function openCreate(locator: any, x: number, y: number) {
    if (!onContextMenuCreate) return;
    onContextMenuCreate(
      { archive_id: "", target_kind: "docx", target_ref: fileId, locator: { docx_kind: "attachment", ...locator }, content: "" },
      x,
      y
    );
  }

  function selectionRangeWithin(el: Element): { start: number; end: number } | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const startEl =
      (range.startContainer as any)?.nodeType === 1
        ? (range.startContainer as Element)
        : (range.startContainer as any)?.parentElement;
    const endEl =
      (range.endContainer as any)?.nodeType === 1
        ? (range.endContainer as Element)
        : (range.endContainer as any)?.parentElement;
    if (!startEl || !endEl) return null;
    if (!el.contains(startEl) || !el.contains(endEl)) return null;
    const pre = document.createRange();
    pre.setStart(el, 0);
    pre.setEnd(range.startContainer, range.startOffset);
    const start = pre.toString().length;
    const selectedText = range.toString();
    const end = start + selectedText.length;
    const total = (el.textContent ?? "").length;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    if (start < 0 || end > total) return null;
    return { start, end };
  }

  return (
    <div ref={rootRef} style={{ display: "grid", gap: 10 }}>
      {msg ? <div style={{ whiteSpace: "pre-wrap", color: "#b00" }}>{msg}</div> : null}

      {/* 文本页 */}
      {pages.length ? (
        <div style={{ display: "grid", gap: 10 }}>
          {pages.map((p) => {
            const ids = annotations?.byPage?.[p.page] ?? [];
            return (
              <div
                key={p.page}
                id={pageAnchorId(fileId, p.page)}
                style={{
                  border: ids.length ? "2px solid #f59e0b" : "1px solid #eee",
                  borderRadius: 12,
                  background: "#fff",
                  padding: 10,
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  openCreate({ page: p.page }, e.clientX, e.clientY);
                }}
                onClick={() => {
                  if (!ids.length) return;
                  onAnnotationClick?.(ids[0]);
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                  <div style={{ fontSize: 12, opacity: 0.7 }}>第 {p.page} 页（右键可对该页批注）</div>
                  {ids.length ? (
                    <div
                      style={{
                        fontSize: 12,
                        padding: "2px 8px",
                        borderRadius: 999,
                        border: "1px solid #f59e0b",
                        background: "#fffbeb",
                        color: "#92400e",
                      }}
                    >
                      批注 {ids.length}
                    </div>
                  ) : null}
                </div>

                <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
                  {p.paras.map((para) => {
                    const pid = paraAnchorId(fileId, para.para_idx);
                    const annoIds = annotations?.byPara?.[para.para_idx] ?? [];
                    const focusRanges =
                      focus && typeof focus.para_idx === "number" && focus.para_idx === para.para_idx
                        ? focus.ranges ?? []
                        : [];
                    return (
                      <div
                        key={para.para_idx}
                        id={pid}
                        data-para-idx={para.para_idx}
                        style={{
                          border: annoIds.length ? "1px solid #fde68a" : "1px solid #f3f4f6",
                          borderRadius: 10,
                          background: annoIds.length ? "#fffbeb" : "#fafafa",
                          padding: 10,
                          cursor: annoIds.length ? "pointer" : "default",
                        }}
                        onClick={() => {
                          if (!annoIds.length) return;
                          onAnnotationClick?.(annoIds[0]);
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          const r = selectionRangeWithin(e.currentTarget);
                          if (r) openCreate({ para_idx: para.para_idx, start: r.start, end: r.end }, e.clientX, e.clientY);
                          else openCreate({ para_idx: para.para_idx }, e.clientX, e.clientY);
                        }}
                      >
                        <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 6 }}>段落 #{para.para_idx + 1}</div>
                        <div style={{ whiteSpace: "pre-wrap", fontSize: 12, lineHeight: 1.65 }}>
                          {focusRanges.length ? <TextHighlighter text={para.text} ranges={focusRanges} /> : para.text}
                        </div>
                        {annoIds.length ? (
                          <div style={{ marginTop: 6, fontSize: 12, color: "#92400e" }}>已批注 {annoIds.length} 条（点击打开）</div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      {/* 图片（独立区域，允许图片级批注） */}
      {imgs.length ? (
        <div
          style={{
            border: "1px solid #eee",
            borderRadius: 12,
            background: "#fff",
            padding: 10,
          }}
        >
          <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>图片（右键可对图片批注）</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
            {imgs.slice(0, 30).map((p, idx) => {
              const annoIds = annotations?.byImage?.[idx] ?? [];
              return (
                <div
                  key={idx}
                  id={imageAnchorId(fileId, idx)}
                  style={{
                    border: annoIds.length ? "2px solid #f59e0b" : "1px solid #eee",
                    borderRadius: 10,
                    overflow: "hidden",
                    background: "#fff",
                    position: "relative",
                    cursor: annoIds.length ? "pointer" : "default",
                  }}
                  onClick={() => {
                    if (!annoIds.length) return;
                    onAnnotationClick?.(annoIds[0]);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    openCreate({ image_index: idx }, e.clientX, e.clientY);
                  }}
                >
                  {annoIds.length ? (
                    <div
                      style={{
                        position: "absolute",
                        top: 8,
                        right: 8,
                        background: "#fffbeb",
                        border: "1px solid #f59e0b",
                        color: "#92400e",
                        borderRadius: 999,
                        padding: "2px 6px",
                        fontSize: 12,
                        zIndex: 2,
                      }}
                    >
                      {annoIds.length}
                    </div>
                  ) : null}
                  <img
                    src={convertFileSrc(p)}
                    style={{
                      width: "100%",
                      height: 140,
                      objectFit: "cover",
                      display: "block",
                    }}
                  />
                </div>
              );
            })}
          </div>
          {imgs.length > 30 ? <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>还有 {imgs.length - 30} 张图片</div> : null}
        </div>
      ) : null}
    </div>
  );
}

function pageAnchorId(fileId: string, page: number) {
  return `docxatt-${safeId(fileId)}-page-${page}`;
}

function paraAnchorId(fileId: string, paraIdx: number) {
  return `docxatt-${safeId(fileId)}-para-${paraIdx}`;
}

function imageAnchorId(fileId: string, imgIdx: number) {
  return `docxatt-${safeId(fileId)}-img-${imgIdx}`;
}

function safeId(s: string) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, "_");
}

function cssEscape(id: string) {
  // 简单转义：把可能影响 querySelector 的字符替换掉
  return id.replace(/([ #;?%&,.+*~\':"!^$[\]()=>|/@])/g, "\\$1");
}

