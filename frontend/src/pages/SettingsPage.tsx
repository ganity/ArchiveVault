import { useEffect, useState } from "react";
import { invoke } from "../tauri";

type LibraryStatus = {
  library_root: string;
  tz: string;
  has_data: boolean;
};

export default function SettingsPage() {
  const [status, setStatus] = useState<LibraryStatus | null>(null);
  const [newRoot, setNewRoot] = useState("");
  const [migrateTo, setMigrateTo] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setMsg("");
    const s = await invoke<LibraryStatus>("get_library_status");
    setStatus(s);
    setNewRoot(s.library_root);
    setMigrateTo(s.library_root);
  }

  useEffect(() => {
    refresh().catch((e) => setMsg(String(e?.message ?? e)));
  }, []);

  async function applyRoot() {
    setBusy(true);
    setMsg("");
    try {
      const s = await invoke<LibraryStatus>("set_library_root", { newRoot });
      setStatus(s);
      setMsg("已应用库目录");
    } catch (e: any) {
      setMsg(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function chooseRoot() {
    setMsg("");
    try {
      const p = await invoke<string | null>("pick_folder");
      if (p) setNewRoot(p);
    } catch (e: any) {
      setMsg(String(e?.message ?? e));
    }
  }

  async function chooseMigrateTo() {
    setMsg("");
    try {
      const p = await invoke<string | null>("pick_folder");
      if (p) setMigrateTo(p);
    } catch (e: any) {
      setMsg(String(e?.message ?? e));
    }
  }

  async function migrate() {
    if (!status) return;
    if (!migrateTo.trim()) {
      setMsg("请输入迁移目标目录");
      return;
    }
    if (!window.confirm("将迁移库到新目录，并清理旧库中的数据（move）。确认继续？")) return;
    setBusy(true);
    setMsg("");
    try {
      const r = await invoke<string>("migrate_library_minimal_move", {
        req: { from_root: status.library_root, to_root: migrateTo },
      });
      setMsg(r);
      await refresh();
    } catch (e: any) {
      setMsg(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function cleanupAllCache() {
    if (!window.confirm("确认清理全部缓存？不会删除原始ZIP，后续预览会自动重建。")) return;
    setBusy(true);
    setMsg("");
    try {
      const r = await invoke<string>("cleanup_cache");
      setMsg(r);
    } catch (e: any) {
      setMsg(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: "24px 20px", height: "100%", overflow: "auto", background: "var(--bg-color)" }}>
      <div style={{ maxWidth: 800, margin: "0 auto" }}>
        <header style={{ marginBottom: 24 }}>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: "var(--text-main)" }}>设置</h1>
          <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 4 }}>配置库路径及系统参数</p>
        </header>

        {status ? (
          <div style={{ display: "grid", gap: 20 }}>
            {/* 状态卡片 */}
            <div className="card" style={{ padding: 20 }}>
              <div style={{ display: "flex", gap: 32 }}>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 4 }}>时区</div>
                  <div style={{ fontSize: 15, fontWeight: 500 }}>{status.tz}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 4 }}>现存数据</div>
                  <div style={{ fontSize: 15, fontWeight: 500 }}>{status.has_data ? "✅ 库中已有数据" : "❌ 暂无数据"}</div>
                </div>
              </div>
            </div>

            {/* 库目录设置 */}
            <div className="card" style={{ padding: 20 }}>
              <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>库目录管理</h3>
              <div style={{ display: "grid", gap: 16 }}>
                <label style={{ display: "grid", gap: 8 }}>
                  <span style={{ fontSize: 13, color: "var(--text-muted)" }}>当前库根路径（已有数据后禁止直接修改）</span>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      style={{ flex: 1 }}
                      value={newRoot}
                      onChange={(e) => setNewRoot(e.target.value)}
                    />
                    <button onClick={chooseRoot} disabled={busy}>选择目录</button>
                  </div>
                </label>

                <div style={{ display: "flex", gap: 10, paddingTop: 8 }}>
                  <button className="primary" disabled={busy} onClick={applyRoot}>应用目录</button>
                  <button onClick={refresh} disabled={busy}>刷新状态</button>
                  <button
                    style={{ marginLeft: "auto", color: "#64748b" }}
                    disabled={busy}
                    onClick={cleanupAllCache}
                  >
                    🗑️ 清理全部缓存
                  </button>
                </div>
              </div>
            </div>

            {/* 迁移卡片 */}
            <div className="card" style={{ padding: 20, borderTop: "4px solid #f59e0b" }}>
              <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>库迁移</h3>
              <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 16 }}>将现有库整体移动到新位置。此操作会将原始文件从旧目录物理移动到新目录。</p>

              <div style={{ display: "grid", gap: 16 }}>
                <label style={{ display: "grid", gap: 8 }}>
                  <span style={{ fontSize: 13, color: "var(--text-muted)" }}>目标迁移目录（必须为空）</span>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      style={{ flex: 1 }}
                      value={migrateTo}
                      onChange={(e) => setMigrateTo(e.target.value)}
                    />
                    <button onClick={chooseMigrateTo} disabled={busy}>选择目标</button>
                  </div>
                </label>

                <div style={{ paddingTop: 8 }}>
                  <button
                    disabled={busy}
                    onClick={migrate}
                    style={{ color: "#b45309", borderColor: "#fcd34d", background: "#fffbeb" }}
                  >
                    🚀 开始迁移
                  </button>
                </div>
              </div>
            </div>

            {msg ? (
              <div style={{
                padding: "12px 16px",
                borderRadius: 8,
                background: msg.includes("应用") || msg.includes("成功") || msg.includes("完成") ? "#f0fdf4" : "#fef2f2",
                color: msg.includes("应用") || msg.includes("成功") || msg.includes("完成") ? "#15803d" : "#b91c1c",
                fontSize: 14,
                fontWeight: 500,
                border: "1px solid currentColor",
                opacity: 0.9
              }}>
                {msg}
              </div>
            ) : null}
          </div>
        ) : (
          <div style={{ display: "flex", justifyContent: "center", padding: 40, color: "var(--text-muted)" }}>
            正在加载系统设置...
          </div>
        )}
      </div>
    </div>
  );
}
