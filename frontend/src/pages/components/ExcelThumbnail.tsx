import { useEffect, useState } from "react";
import { invoke } from "../../tauri";

type SheetInfo = { name: string; rows: number; cols: number };
type InfoResp = { file_id: string; sheets: SheetInfo[]; default_sheet?: string | null };
type CellsResp = { row_start: number; col_start: number; cells: string[][] };

export default function ExcelThumbnail({
  fileId,
  maxRows = 18,
  maxCols = 8,
}: {
  fileId: string;
  maxRows?: number;
  maxCols?: number;
}) {
  const [msg, setMsg] = useState("");
  const [cells, setCells] = useState<string[][]>([]);

  useEffect(() => {
    let cancelled = false;
    setMsg("");
    setCells([]);

    async function run() {
      const info = await invoke<InfoResp>("get_excel_sheet_info", { fileId });
      const sheet = info.default_sheet ?? info.sheets[0]?.name;
      if (!sheet) return;
      const resp = await invoke<CellsResp>("get_excel_sheet_cells", {
        req: {
          file_id: fileId,
          sheet_name: sheet,
          row_start: 0,
          row_end: maxRows,
          col_start: 0,
          col_end: maxCols,
        },
      });
      if (cancelled) return;
      setCells(resp.cells ?? []);
    }

    run().catch((e) => setMsg(String(e?.message ?? e)));
    return () => {
      cancelled = true;
    };
  }, [fileId, maxRows, maxCols]);

  return (
    <div style={{ border: "1px solid #eee", borderRadius: 10, overflow: "auto", background: "#fff", maxHeight: 220 }}>
      {msg ? <div style={{ padding: 8, whiteSpace: "pre-wrap", color: "#b00" }}>{msg}</div> : null}
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <tbody>
          {cells.map((row, rIdx) => (
            <tr key={rIdx}>
              {row.map((v, cIdx) => (
                <td
                  key={cIdx}
                  style={{
                    borderRight: "1px solid #f0f0f0",
                    borderBottom: "1px solid #f0f0f0",
                    padding: "4px 6px",
                    fontSize: 12,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    maxWidth: 160,
                  }}
                  title={v}
                >
                  {v}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

