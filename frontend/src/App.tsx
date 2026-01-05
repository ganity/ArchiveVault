import { useEffect, useState } from "react";
import SearchPage from "./pages/SearchPage";
import SettingsPage from "./pages/SettingsPage";
import { invoke, listen } from "./tauri";
import ArchiveDetail from "./pages/components/ArchiveDetail";

type Page = "search" | "detail" | "settings";

type ProgressEvent = {
  operation: string;
  current: number;
  total: number;
  step: string;
  message: string;
  is_complete: boolean;
};

export default function App() {
  const [page, setPage] = useState<Page>("search");
  const [ready, setReady] = useState(false);
  const [isTauri, setIsTauri] = useState(false);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [searchRefreshToken, setSearchRefreshToken] = useState(0);
  const [globalMsg, setGlobalMsg] = useState<{ text: string, type: 'info' | 'error' } | null>(null);
  const [isImporting, setIsImporting] = useState(false);

  const [detailCtx, setDetailCtx] = useState<{
    archiveId: string;
    open:
    | {
      kind: "docx";
      block_id?: string;
      highlights?: { start: number; end: number }[];
      field_name?: string;
      field_highlights?: { start: number; end: number }[];
    }
    | { kind: "attachment"; file_id: string; highlights?: { start: number; end: number }[]; display_name?: string }
    | { kind: "annotation"; annotation_id: string }
    | null;
  } | null>(null);

  useEffect(() => {
    // Tauri 注入可能略有延迟（尤其是 Windows）；isTauri 不能只在首帧判断
    setReady(true);
    let cancelled = false;
    const check = () => {
      if (cancelled) return;
      const ok = Boolean(
        (window as any).__TAURI__ ||
        (window as any).__TAURI_INTERNALS__ ||
        typeof (window as any).__TAURI_INVOKE__ === "function"
      );
      setIsTauri(ok);
      if (!ok) setTimeout(check, 50);
    };
    check();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | null = null;
    listen<ProgressEvent>("progress_update", (p) => {
      setProgress(p);
      if (p?.is_complete) {
        setTimeout(() => setProgress(null), 1200);
      }
    })
      .then((fn) => (unlisten = fn))
      .catch(() => { });
    return () => {
      unlisten?.();
    };
  }, [isTauri]);

  async function handleImport(type: 'file' | 'folder') {
    setGlobalMsg(null);
    setIsImporting(true);
    try {
      let paths: string[] = [];
      if (type === 'file') {
        paths = await invoke<string[]>("pick_zip_files");
      } else {
        paths = await invoke<string[]>("pick_zip_folder_files");
      }

      if (!paths.length) {
        setIsImporting(false);
        return;
      }

      const r = await invoke<any>("import_zips", { paths });
      setGlobalMsg({
        text: `导入完成：成功 ${r.imported}，跳过 ${r.skipped}，失败 ${r.failed}`,
        type: r.failed > 0 ? 'error' : 'info'
      });
      setSearchRefreshToken(t => t + 1);

      // 3秒后自动清除消息
      setTimeout(() => setGlobalMsg(null), 5000);
    } catch (e: any) {
      setGlobalMsg({ text: String(e?.message ?? e), type: 'error' });
    } finally {
      setIsImporting(false);
    }
  }

  if (!ready) return null;

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "var(--bg-color)" }}>
      <header
        style={{
          padding: "0 20px",
          height: 60,
          background: "white",
          borderBottom: "1px solid var(--border-color)",
          display: "flex",
          alignItems: "center",
          boxShadow: "0 1px 3px rgba(0,0,0,0.02)",
          zIndex: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginRight: 32 }}>
          <div style={{
            width: 32, height: 32,
            background: "linear-gradient(135deg, var(--primary-color), #4f46e5)",
            borderRadius: 8,
            display: "flex", alignItems: "center", justifyContent: "center",
            color: "white", fontWeight: "bold", fontSize: 18,
            boxShadow: "0 2px 4px rgba(37, 99, 235, 0.2)"
          }}>A</div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <strong style={{ fontSize: 16, color: "var(--text-main)", letterSpacing: "-0.5px", lineHeight: 1.2 }}>ArchiveVault</strong>
            <span style={{ fontSize: 10, color: "var(--text-muted)", fontWeight: 600, letterSpacing: "0.5px" }}>{isTauri ? "DESKTOP" : "WEB"}</span>
          </div>
        </div>

        <nav style={{ display: "flex", gap: 4, background: "#f1f5f9", padding: 4, borderRadius: 10 }}>
          {page === "detail" ? (
            <button
              className="primary"
              onClick={() => setPage("search")}
              style={{ borderRadius: 8, height: 32, padding: "0 12px", fontSize: 13 }}
            >
              ← 返回搜索
            </button>
          ) : (
            <>
              <button
                className={page === "search" ? "primary" : ""}
                onClick={() => setPage("search")}
                disabled={page === "search"}
                style={{ border: "none", background: page === "search" ? "var(--primary-color)" : "transparent", color: page === "search" ? "white" : "var(--text-muted)", borderRadius: 7, height: 32, padding: "0 16px", fontSize: 13, fontWeight: 500 }}
              >
                搜索
              </button>
              <button
                className={page === "settings" ? "primary" : ""}
                onClick={() => setPage("settings")}
                disabled={page === "settings"}
                style={{ border: "none", background: page === "settings" ? "var(--primary-color)" : "transparent", color: page === "settings" ? "white" : "var(--text-muted)", borderRadius: 7, height: 32, padding: "0 16px", fontSize: 13, fontWeight: 500 }}
              >
                设置
              </button>
            </>
          )}
        </nav>

        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
          {globalMsg && (
            <div style={{
              fontSize: 13,
              color: globalMsg.type === 'error' ? '#ef4444' : 'var(--primary-color)',
              fontWeight: 500,
              marginRight: 10,
              padding: "4px 12px",
              background: globalMsg.type === 'error' ? '#fef2f2' : '#eff6ff',
              borderRadius: 6,
              animation: "fadeIn 0.3s ease-out"
            }}>
              {globalMsg.text}
            </div>
          )}

          <div style={{ display: "flex", gap: 8, paddingRight: 10, borderRight: "1px solid var(--border-color)", marginRight: 10 }}>
            <button
              onClick={() => handleImport('file')}
              disabled={isImporting}
              style={{ height: 36, padding: "0 12px", fontSize: 13, borderColor: "var(--border-color)" }}
            >
              📂 导入 ZIP
            </button>
            <button
              onClick={() => handleImport('folder')}
              disabled={isImporting}
              style={{ height: 36, padding: "0 12px", fontSize: 13, borderColor: "var(--border-color)" }}
            >
              📁 导入文件夹
            </button>
          </div>

          <div style={{ width: 32, height: 32, borderRadius: "50%", background: "#e2e8f0", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>
            👤
          </div>
        </div>
      </header>

      {progress ? (
        <div style={{
          padding: "12px 20px",
          background: "white",
          borderBottom: "1px solid var(--border-color)",
          animation: "fadeIn 0.3s ease-out"
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <div style={{ fontWeight: 500, color: "var(--text-main)" }}>
              {progress.step} <span style={{ color: "var(--text-muted)", fontWeight: 400, marginLeft: 4 }}>{progress.message}</span>
            </div>
            <div style={{ fontSize: 13, color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>
              {progress.current} / {progress.total}
            </div>
          </div>
          <div style={{ height: 8, background: "#f1f5f9", borderRadius: 4, overflow: "hidden" }}>
            <div
              style={{
                height: "100%",
                width: `${progress.total > 0 ? Math.min(100, (progress.current / progress.total) * 100) : 0}%`,
                background: "linear-gradient(90deg, #3b82f6, #2563eb)",
                borderRadius: 4,
                transition: "width 0.3s ease-out"
              }}
            />
          </div>
        </div>
      ) : null}

      <main style={{ flex: 1, minHeight: 0, position: "relative" }}>
        <div style={{ display: page === "settings" ? "block" : "none", height: "100%" }}>
          <SettingsPage />
        </div>
        <div style={{ display: page === "settings" ? "none" : page === "search" ? "block" : "none", height: "100%" }}>
          <SearchPage
            refreshToken={searchRefreshToken}
            onOpenArchive={(archiveId, open) => {
              setDetailCtx({ archiveId, open });
              setPage("detail");
            }}
          />
        </div>
        <div style={{ display: page === "detail" && detailCtx ? "block" : "none", height: "100%" }}>
          {detailCtx ? (
            <ArchiveDetail
              archiveId={detailCtx.archiveId}
              open={detailCtx.open}
              onArchiveDeleted={async () => {
                setDetailCtx(null);
                setPage("search");
                setSearchRefreshToken((t) => t + 1);
              }}
            />
          ) : null}
        </div>
      </main>
    </div>
  );
}
