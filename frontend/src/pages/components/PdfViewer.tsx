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

export default function PdfViewer({
  filePath,
  page,
  onPageChange,
}: {
  filePath: string;
  page?: number | null;
  onPageChange?: (page: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [msg, setMsg] = useState("");
  const [curPage, setCurPage] = useState(1);
  const [pages, setPages] = useState(0);

  const src = useMemo(() => convertFileSrc(filePath), [filePath]);
  const docRef = useRef<any>(null);

  useEffect(() => {
    let cancelled = false;
    setMsg("");
    setCurPage(1);
    setPages(0);
    docRef.current = null;

    async function run() {
      const pdfjsLib = ensurePdfJs();
      const ab = await fetch(src).then((r) => r.arrayBuffer());
      const doc = await pdfjsLib.getDocument({ data: ab }).promise;
      if (cancelled) return;
      docRef.current = doc;
      setPages(doc.numPages);
      await renderPage(doc, 1);

      async function renderPage(doc: any, p: number) {
        const pg = await doc.getPage(p);
        const viewport = pg.getViewport({ scale: 1.4 });
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        await pg.render({ canvasContext: ctx, viewport }).promise;
      }

      // 保存渲染函数
      (PdfViewer as any).__render = renderPage;
    }

    run().catch((e) => setMsg(String(e?.message ?? e)));
    return () => {
      cancelled = true;
    };
  }, [src]);

  async function goto(p: number) {
    const render = (PdfViewer as any).__render;
    const doc = docRef.current;
    if (!doc || !render) return;
    const next = Math.max(1, Math.min(pages || 1, p));
    setCurPage(next);
    onPageChange?.(next);
    try {
      await render(doc, next);
    } catch (e: any) {
      setMsg(String(e?.message ?? e));
    }
  }

  useEffect(() => {
    if (page == null) return;
    if (!pages) return;
    if (page === curPage) return;
    goto(page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pages]);

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button onClick={() => goto(curPage - 1)} disabled={curPage <= 1}>
          上一页
        </button>
        <button onClick={() => goto(curPage + 1)} disabled={pages ? curPage >= pages : true}>
          下一页
        </button>
        <div style={{ opacity: 0.7 }}>
          {curPage}/{pages || "-"}
        </div>
      </div>
      {msg ? <div style={{ whiteSpace: "pre-wrap", color: "#b00" }}>{msg}</div> : null}
      <div style={{ overflow: "auto", border: "1px solid #eee", borderRadius: 8 }}>
        <canvas ref={canvasRef} style={{ display: "block", margin: "0 auto" }} />
      </div>
    </div>
  );
}
