import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "../../tauri";

type PdfJs = any;

function getPdfJs(): PdfJs | null {
  return (window as any).pdfjsLib ?? null;
}

function ensurePdfJs(): PdfJs {
  const lib = getPdfJs();
  if (!lib) throw new Error("PDF.js 未加载（pdfjsLib 缺失）");
  if (!lib.GlobalWorkerOptions?.workerSrc) {
    lib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.js";
  }
  return lib;
}

export default function PdfAllPagesViewer({
  filePath,
  focusPage,
  annotatedPages,
  onPageContextMenu,
  onPageClick,
  variant,
  anchorPrefix,
}: {
  filePath: string;
  focusPage?: number | null;
  annotatedPages?: Record<number, string[]>;
  onPageContextMenu?: (page: number, e: React.MouseEvent) => void;
  onPageClick?: (page: number) => void;
  variant?: "full" | "thumbs";
  anchorPrefix?: string;
}) {
  const [msg, setMsg] = useState("");
  const [pages, setPages] = useState(0);
  const docRef = useRef<any>(null);
  const renderedRef = useRef<Set<number>>(new Set());
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  const src = useMemo(() => convertFileSrc(filePath), [filePath]);

  useEffect(() => {
    let cancelled = false;
    setMsg("");
    setPages(0);
    docRef.current = null;
    renderedRef.current = new Set();

    async function run() {
      const pdfjsLib = ensurePdfJs();
      const ab = await fetch(src).then((r) => r.arrayBuffer());
      const doc = await pdfjsLib.getDocument({ data: ab }).promise;
      if (cancelled) return;
      docRef.current = doc;
      setPages(doc.numPages ?? 0);
    }

    run().catch((e) => setMsg(String(e?.message ?? e)));
    return () => {
      cancelled = true;
    };
  }, [src]);

  useEffect(() => {
    if (!focusPage) return;
    const el = pageRefs.current.get(focusPage);
    el?.scrollIntoView({ block: "start" });
  }, [focusPage, pages]);

  useEffect(() => {
    if (!pages) return;
    const doc = docRef.current;
    if (!doc) return;

    const io = new IntersectionObserver(
      (entries) => {
        for (const ent of entries) {
          if (!ent.isIntersecting) continue;
          const el = ent.target as HTMLElement;
          const page = Number(el.getAttribute("data-page"));
          if (!page || renderedRef.current.has(page)) continue;
          const canvas = el.querySelector("canvas") as HTMLCanvasElement | null;
          if (!canvas) continue;
          renderedRef.current.add(page);
          renderOnePage(doc, page, canvas).catch(() => {
            renderedRef.current.delete(page);
          });
        }
      },
      { root: null, rootMargin: "600px 0px 600px 0px", threshold: 0.01 }
    );

    const els: HTMLElement[] = [];
    for (let p = 1; p <= pages; p++) {
      const el = pageRefs.current.get(p);
      if (el) {
        io.observe(el);
        els.push(el);
      }
    }
    return () => {
      for (const el of els) io.unobserve(el);
      io.disconnect();
    };
  }, [pages]);

  async function renderOnePage(doc: any, p: number, canvas: HTMLCanvasElement) {
    const pg = await doc.getPage(p);
    const viewport = pg.getViewport({ scale: variant === "thumbs" ? 0.45 : 1.2 });
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await pg.render({ canvasContext: ctx, viewport }).promise;
  }

  return (
    <div style={{ display: "grid", gap: 10 }}>
      {msg ? <div style={{ whiteSpace: "pre-wrap", color: "#b00" }}>{msg}</div> : null}
      <div style={{ fontSize: 12, opacity: 0.7 }}>
        {pages ? `共 ${pages} 页（默认平铺，滚动浏览）` : "加载中..."}
      </div>
      <div
        style={
          variant === "thumbs"
            ? {
                display: "grid",
                gap: 10,
                gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
              }
            : { display: "grid", gap: 12 }
        }
      >
        {Array.from({ length: pages }).map((_, idx) => {
          const p = idx + 1;
          const ann = annotatedPages?.[p] ?? [];
          const id = anchorPrefix ? `${anchorPrefix}-p-${p}` : undefined;
          return (
            <div
              key={p}
              id={id}
              data-page={p}
              ref={(el) => {
                if (!el) return;
                pageRefs.current.set(p, el);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onPageContextMenu?.(p, e);
              }}
              onClick={() => onPageClick?.(p)}
              style={{
                border: ann.length ? "2px solid #f59e0b" : "1px solid #e5e7eb",
                borderRadius: 12,
                padding: variant === "thumbs" ? 8 : 10,
                background: "#fff",
                position: "relative",
              }}
            >
              <div style={{ fontSize: 12, opacity: 0.7, marginBottom: variant === "thumbs" ? 6 : 8 }}>第 {p} 页</div>
              {ann.length ? (
                <div
                  style={{
                    position: "absolute",
                    top: 10,
                    right: 10,
                    background: "#fffbeb",
                    border: "1px solid #f59e0b",
                    color: "#92400e",
                    borderRadius: 999,
                    padding: "2px 8px",
                    fontSize: 12,
                  }}
                  title="该页存在批注"
                >
                  批注 {ann.length}
                </div>
              ) : null}
              <div style={{ overflow: "auto" }}>
                <canvas style={{ display: "block", margin: "0 auto", maxWidth: "100%", height: "auto" }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
