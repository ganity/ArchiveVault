import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "../../tauri";

type SheetInfo = { name: string; rows: number; cols: number };
type InfoResp = { file_id: string; sheets: SheetInfo[]; default_sheet?: string | null };
type CellsResp = { row_start: number; col_start: number; cells: string[][] };

const ROW_HEIGHT = 26;
const COL_WIDTH = 140;
const ROW_HEADER_WIDTH = 56;
const COL_HEADER_HEIGHT = 28;
const OVERSCAN_ROWS = 12;
const OVERSCAN_COLS = 4;
const MAX_WINDOW_ROWS = 260;
const MAX_WINDOW_COLS = 60;

export default function ExcelViewer({
  fileId,
  annotations,
  onCellContextMenu,
  onAnnotationClick,
  focus,
}: {
  fileId: string;
  annotations?: { annotation_id: string; sheet_name: string; row: number; col?: number }[];
  onCellContextMenu?: (
    req: { archive_id: string; target_kind: string; target_ref: string; locator: any; content: string },
    x: number,
    y: number
  ) => void;
  onAnnotationClick?: (annotationId: string) => void;
  focus?: { sheet_name: string; row: number; col?: number } | null;
}) {
  const [info, setInfo] = useState<InfoResp | null>(null);
  const [sheet, setSheet] = useState<string>("");
  const [cells, setCells] = useState<string[][]>([]);
  const [rowStart, setRowStart] = useState(0);
  const [colStart, setColStart] = useState(0);
  const [viewport, setViewport] = useState({ w: 0, h: 0, scrollLeft: 0, scrollTop: 0 });
  const [msg, setMsg] = useState("");
  const [focusCell, setFocusCell] = useState<{ row: number; col?: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const cacheRef = useRef<Map<string, CellsResp>>(new Map());

  const sheetDim = useMemo(() => {
    const s = info?.sheets?.find((x) => x.name === sheet);
    return { rows: s?.rows ?? 0, cols: s?.cols ?? 0 };
  }, [info, sheet]);

  const windowSize = useMemo(() => {
    const visibleRows = viewport.h > 0 ? Math.ceil(viewport.h / ROW_HEIGHT) : 20;
    const visibleCols = viewport.w > 0 ? Math.ceil(viewport.w / COL_WIDTH) : 10;
    const rows = Math.min(MAX_WINDOW_ROWS, visibleRows + OVERSCAN_ROWS * 2);
    const cols = Math.min(MAX_WINDOW_COLS, visibleCols + OVERSCAN_COLS * 2);
    return { rows, cols };
  }, [viewport.h, viewport.w]);

  const rowEnd = useMemo(() => rowStart + windowSize.rows, [rowStart, windowSize.rows]);
  const colEnd = useMemo(() => colStart + windowSize.cols, [colStart, windowSize.cols]);

  useEffect(() => {
    setMsg("");
    setInfo(null);
    setCells([]);
    cacheRef.current.clear();
    invoke<InfoResp>("get_excel_sheet_info", { fileId })
      .then((r) => {
        setInfo(r);
        const s = r.default_sheet ?? r.sheets[0]?.name ?? "";
        setSheet(s);
        setRowStart(0);
        setColStart(0);
      })
      .catch((e) => setMsg(String(e?.message ?? e)));
  }, [fileId]);

  useEffect(() => {
    const el0 = scrollRef.current;
    if (!el0) return;
    const el = el0;

    function onScroll() {
      setViewport((v) => ({
        ...v,
        scrollLeft: el.scrollLeft,
        scrollTop: el.scrollTop,
      }));
    }

    const ro = new ResizeObserver(() => {
      setViewport((v) => ({
        ...v,
        w: el.clientWidth,
        h: el.clientHeight,
        scrollLeft: el.scrollLeft,
        scrollTop: el.scrollTop,
      }));
    });
    ro.observe(el);
    el.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!sheet) return;
    const el = scrollRef.current;
    if (!el) return;
    // 切sheet时回到左上角
    el.scrollLeft = 0;
    el.scrollTop = 0;
    setRowStart(0);
    setColStart(0);
    setCells([]);
    cacheRef.current.clear();
  }, [sheet]);

  useEffect(() => {
    if (!focus) return;
    if (!focus.sheet_name) return;
    if (focus.sheet_name !== sheet) {
      setSheet(focus.sheet_name);
      return;
    }
    setFocusCell({ row: focus.row, col: focus.col });
    const el = scrollRef.current;
    if (!el) return;
    const top = COL_HEADER_HEIGHT + Math.max(0, focus.row) * ROW_HEIGHT;
    const left = typeof focus.col === "number" ? ROW_HEADER_WIDTH + Math.max(0, focus.col) * COL_WIDTH : null;
    el.scrollTop = Math.max(0, top - ROW_HEIGHT * 2);
    if (left !== null) el.scrollLeft = Math.max(0, left - COL_WIDTH * 1);
  }, [focus, sheet]);

  useEffect(() => {
    if (!sheet) return;
    const { rows, cols } = sheetDim;
    if (!rows || !cols) return;

    const leftCol = Math.max(
      0,
      Math.floor(Math.max(0, viewport.scrollLeft - ROW_HEADER_WIDTH) / COL_WIDTH) - OVERSCAN_COLS
    );
    const topRow = Math.max(
      0,
      Math.floor(Math.max(0, viewport.scrollTop - COL_HEADER_HEIGHT) / ROW_HEIGHT) - OVERSCAN_ROWS
    );

    const nextRowStart = Math.min(Math.max(0, rows - 1), topRow);
    const nextColStart = Math.min(Math.max(0, cols - 1), leftCol);

    // 若已在窗口内则不变
    if (nextRowStart === rowStart && nextColStart === colStart) return;
    setRowStart(nextRowStart);
    setColStart(nextColStart);
  }, [viewport.scrollLeft, viewport.scrollTop, sheetDim, rowStart, colStart]);

  useEffect(() => {
    if (!sheet) return;
    setMsg("");
    const { rows, cols } = sheetDim;
    if (!rows || !cols) return;

    const r0 = clamp(rowStart, 0, rows);
    const c0 = clamp(colStart, 0, cols);
    const r1 = clamp(rowEnd, r0, rows);
    const c1 = clamp(colEnd, c0, cols);
    if (r1 <= r0 || c1 <= c0) return;

    const key = `${fileId}|${sheet}|${r0}|${r1}|${c0}|${c1}`;
    const cached = cacheRef.current.get(key);
    if (cached) {
      setCells(cached.cells);
      return;
    }

    invoke<CellsResp>("get_excel_sheet_cells", {
      req: { file_id: fileId, sheet_name: sheet, row_start: r0, row_end: r1, col_start: c0, col_end: c1 },
    })
      .then((r) => {
        cacheRef.current.set(key, r);
        setCells(r.cells);
      })
      .catch((e) => setMsg(String(e?.message ?? e)));
  }, [fileId, sheet, rowStart, colStart, rowEnd, colEnd]);

  const annotationsForSheet = useMemo(() => {
    return (annotations ?? []).filter((a) => a.sheet_name === sheet);
  }, [annotations, sheet]);

  const rowAnno = useMemo(() => {
    const m = new Map<number, string[]>();
    for (const a of annotationsForSheet) {
      if (typeof a.row !== "number") continue;
      if (typeof a.col === "number") continue;
      m.set(a.row, [...(m.get(a.row) ?? []), a.annotation_id]);
    }
    return m;
  }, [annotationsForSheet]);

  const cellAnno = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const a of annotationsForSheet) {
      if (typeof a.row !== "number") continue;
      if (typeof a.col !== "number") continue;
      const k = `${a.row}|${a.col}`;
      m.set(k, [...(m.get(k) ?? []), a.annotation_id]);
    }
    return m;
  }, [annotationsForSheet]);

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <label>
          Sheet：
          <select value={sheet} onChange={(e) => setSheet(e.target.value)}>
            {(info?.sheets ?? []).map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <div style={{ opacity: 0.7 }}>
          行 {rowStart}-{rowEnd - 1}，列 {colStart}-{colEnd - 1}（滚动浏览全表）
        </div>
      </div>
      {msg ? <div style={{ whiteSpace: "pre-wrap", color: "#b00" }}>{msg}</div> : null}
      <div
        ref={scrollRef}
        style={{
          position: "relative",
          overflow: "auto",
          border: "1px solid #eee",
          borderRadius: 8,
          height: 520,
          background: "#fff",
        }}
      >
        <div
          style={{
            width: ROW_HEADER_WIDTH + sheetDim.cols * COL_WIDTH,
            height: COL_HEADER_HEIGHT + sheetDim.rows * ROW_HEIGHT,
            position: "relative",
          }}
        />

        {/* 左上角空白 */}
        <div
          style={{
            position: "absolute",
            top: viewport.scrollTop,
            left: viewport.scrollLeft,
            width: ROW_HEADER_WIDTH,
            height: COL_HEADER_HEIGHT,
            background: "#fafafa",
            borderRight: "1px solid #e5e7eb",
            borderBottom: "1px solid #e5e7eb",
            zIndex: 6,
          }}
        />

        {/* 列头 */}
        <div
          style={{
            position: "absolute",
            top: viewport.scrollTop,
            left: ROW_HEADER_WIDTH + colStart * COL_WIDTH,
            display: "flex",
            zIndex: 5,
          }}
        >
          {Array.from({ length: Math.max(0, colEnd - colStart) }).map((_, i) => {
            const c = colStart + i;
            return (
              <div
                key={c}
                style={{
                  width: COL_WIDTH,
                  height: COL_HEADER_HEIGHT,
                  borderRight: "1px solid #e5e7eb",
                  borderBottom: "1px solid #e5e7eb",
                  background: "#fafafa",
                  fontSize: 12,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  boxSizing: "border-box",
                }}
              >
                {toColName(c)}
              </div>
            );
          })}
        </div>

        {/* 行头 */}
        <div
          style={{
            position: "absolute",
            top: COL_HEADER_HEIGHT + rowStart * ROW_HEIGHT,
            left: viewport.scrollLeft,
            zIndex: 4,
          }}
        >
          {Array.from({ length: Math.max(0, rowEnd - rowStart) }).map((_, i) => {
            const r = rowStart + i;
            const ids = rowAnno.get(r) ?? [];
            const isFocus = focusCell?.row === r && typeof focusCell?.col !== "number";
            return (
              <div
                key={r}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (!onCellContextMenu) return;
                  setFocusCell({ row: r });
                  onCellContextMenu(
                    {
                      archive_id: "", // 由上层填充，这里仅占位，外层会覆盖
                      target_kind: "excel",
                      target_ref: fileId,
                      locator: { sheet_name: sheet, row: r },
                      content: "",
                    },
                    e.clientX,
                    e.clientY
                  );
                }}
                onClick={() => {
                  if (!ids.length) return;
                  onAnnotationClick?.(ids[0]);
                }}
                style={{
                  width: ROW_HEADER_WIDTH,
                  height: ROW_HEIGHT,
                  borderRight: "1px solid #e5e7eb",
                  borderBottom: "1px solid #e5e7eb",
                  background: isFocus ? "#dbeafe" : ids.length ? "#fffbeb" : "#fafafa",
                  fontSize: 12,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  boxSizing: "border-box",
                  cursor: ids.length ? "pointer" : "default",
                  position: "relative",
                }}
                title={ids.length ? `该行有批注 ${ids.length} 条（点击打开）` : undefined}
              >
                {r + 1}
                {ids.length ? (
                  <span
                    style={{
                      position: "absolute",
                      right: 4,
                      top: 4,
                      width: 8,
                      height: 8,
                      borderRadius: 999,
                      background: "#f59e0b",
                    }}
                  />
                ) : null}
              </div>
            );
          })}
        </div>

        <div
          style={{
            position: "absolute",
            top: COL_HEADER_HEIGHT + rowStart * ROW_HEIGHT,
            left: ROW_HEADER_WIDTH + colStart * COL_WIDTH,
          }}
        >
          {cells.map((row, rIdx) => (
            <div key={rIdx} style={{ display: "flex" }}>
              {row.map((v, cIdx) => (
                <div
                  key={cIdx}
                  style={{
                    width: COL_WIDTH,
                    height: ROW_HEIGHT,
                    borderRight: "1px solid #f0f0f0",
                    borderBottom: "1px solid #f0f0f0",
                    padding: "4px 6px",
                    fontSize: 12,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    boxSizing: "border-box",
                    position: "relative",
                    outline:
                      focusCell?.row === rowStart + rIdx && focusCell?.col === colStart + cIdx
                        ? "2px solid #3b82f6"
                        : undefined,
                  }}
                  title={v}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!onCellContextMenu) return;
                    const r = rowStart + rIdx;
                    const c = colStart + cIdx;
                    setFocusCell({ row: r, col: c });
                    onCellContextMenu(
                      {
                        archive_id: "",
                        target_kind: "excel",
                        target_ref: fileId,
                        locator: { sheet_name: sheet, row: r, col: c },
                        content: "",
                      },
                      e.clientX,
                      e.clientY
                    );
                  }}
                  onClick={() => {
                    const r = rowStart + rIdx;
                    const c = colStart + cIdx;
                    setFocusCell({ row: r, col: c });
                    const ids = cellAnno.get(`${r}|${c}`) ?? [];
                    if (!ids.length) return;
                    onAnnotationClick?.(ids[0]);
                  }}
                >
                  {v}
                  {(() => {
                    const r = rowStart + rIdx;
                    const c = colStart + cIdx;
                    const ids = cellAnno.get(`${r}|${c}`) ?? [];
                    if (!ids.length) return null;
                    return (
                      <span
                        style={{
                          position: "absolute",
                          right: 2,
                          top: 2,
                          width: 8,
                          height: 8,
                          borderRadius: 999,
                          background: "#f59e0b",
                        }}
                        title="该单元格有批注"
                      />
                    );
                  })()}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function toColName(col: number) {
  // 0 -> A
  let n = col + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
