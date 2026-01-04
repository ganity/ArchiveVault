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

export default function PdfThumbnail({
  filePath,
  page = 1,
  maxHeight = 220,
}: {
  filePath: string;
  page?: number;
  maxHeight?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [msg, setMsg] = useState("");

  const src = useMemo(() => convertFileSrc(filePath), [filePath]);

  useEffect(() => {
    let cancelled = false;
    setMsg("");

    async function run() {
      const pdfjsLib = ensurePdfJs();
      const ab = await fetch(src).then((r) => r.arrayBuffer());
      const doc = await pdfjsLib.getDocument({ data: ab }).promise;
      if (cancelled) return;
      const pg = await doc.getPage(page);
      const raw = pg.getViewport({ scale: 1.0 });
      const scale = raw.height > 0 ? Math.min(1.0, maxHeight / raw.height) : 1.0;
      const viewport = pg.getViewport({ scale });

      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await pg.render({ canvasContext: ctx, viewport }).promise;
    }

    run().catch((e) => setMsg(String(e?.message ?? e)));
    return () => {
      cancelled = true;
    };
  }, [src, page, maxHeight]);

  return (
    <div style={{ border: "1px solid #eee", borderRadius: 10, overflow: "hidden", background: "#fff" }}>
      {msg ? <div style={{ padding: 8, whiteSpace: "pre-wrap", color: "#b00" }}>{msg}</div> : null}
      <div style={{ display: "flex", justifyContent: "center" }}>
        <canvas ref={canvasRef} style={{ display: "block" }} />
      </div>
    </div>
  );
}

