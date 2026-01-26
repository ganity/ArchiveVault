import { useEffect, useState, useMemo } from "react";
import { invoke } from "../tauri";

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

type ListArchivesRequest = {
  date_from?: number | null;
  date_to?: number | null;
  limit?: number | null;
  offset?: number | null;
};

export default function TopicsPage({
  onOpenArchive,
  refreshToken,
}: {
  onOpenArchive: (archiveId: string, open: { kind: "docx" } | null) => void;
  refreshToken?: number;
}) {
  const [archives, setArchives] = useState<ArchiveListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  // 标题编辑状态
  const [editingArchiveId, setEditingArchiveId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState<string>("");
  const [saving, setSaving] = useState(false);

  // 指令内容展开状态
  const [expandedContent, setExpandedContent] = useState<Record<string, boolean>>({});

  const request = useMemo((): ListArchivesRequest => ({
    date_from: toTsStart(dateFrom),
    date_to: toTsEnd(dateTo),
    limit: 50,
    offset: offset,
  }), [dateFrom, dateTo, offset]);

  useEffect(() => {
    loadArchives();
  }, [request, refreshToken]);

  async function loadArchives() {
    try {
      setLoading(true);
      setError("");
      setOffset(0);
      setHasMore(true);
      const result = await invoke<ArchiveListItem[]>("list_archives", { req: request });

      // 前端过滤：根据搜索关键词过滤标题或指令编号
      let filtered = result;
      if (searchQuery.trim()) {
        const query = searchQuery.trim().toLowerCase();
        filtered = filtered.filter(a =>
          a.title?.toLowerCase().includes(query) ||
          a.original_name.toLowerCase().includes(query) ||
          a.instruction_no?.toLowerCase().includes(query)
        );
      }

      setArchives(filtered);
      setHasMore(result.length >= 50);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }

  async function loadMore() {
    if (loadingMore || !hasMore) return;

    try {
      setLoadingMore(true);
      const newRequest = { ...request, offset: archives.length };
      const result = await invoke<ArchiveListItem[]>("list_archives", { req: newRequest });

      // 前端过滤：根据搜索关键词过滤标题或指令编号
      let filtered = result;
      if (searchQuery.trim()) {
        const query = searchQuery.trim().toLowerCase();
        filtered = filtered.filter(a =>
          a.title?.toLowerCase().includes(query) ||
          a.original_name.toLowerCase().includes(query) ||
          a.instruction_no?.toLowerCase().includes(query)
        );
      }

      setArchives(prev => {
        const newArchives = [...prev, ...filtered];
        setOffset(newArchives.length);
        return newArchives;
      });
      setHasMore(result.length >= 50);
    } catch (e: any) {
      console.error("加载更多失败:", e);
    } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    const handleScroll = () => {
      const scrollTop = window.scrollY;
      const windowHeight = window.innerHeight;
      const docHeight = document.documentElement.scrollHeight;

      // 当滚动到距离底部200px时触发加载
      if (docHeight - scrollTop - windowHeight < 200 && !loading && !loadingMore && hasMore) {
        loadMore();
      }
    };

    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, [loading, loadingMore, hasMore, archives]);

  async function saveTitle(archiveId: string) {
    if (!editingTitle.trim()) {
      setError("标题不能为空");
      return;
    }
    try {
      setSaving(true);
      setError("");

      await invoke("update_archive_title", {
        archiveId,
        newTitle: editingTitle.trim(),
      });

      // 更新本地状态
      setArchives(prev =>
        prev.map(a =>
          a.archive_id === archiveId
            ? { ...a, title: editingTitle.trim() }
            : a
        )
      );

      setEditingArchiveId(null);
      setEditingTitle("");
    } catch (e: any) {
      setError(String(e?.message ?? e));
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

  function formatDate(ts: number): string {
    const d = new Date(ts * 1000);
    return d.toLocaleDateString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });
  }

  return (
    <div style={{ height: "100%", overflow: "auto", padding: "40px 20px", background: "var(--bg-color)" }}>
      <div style={{ maxWidth: 900, margin: "0 auto" }}>
        <div style={{ display: "grid", gap: 24 }}>
          {/* 搜索和过滤区域 */}
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
            {/* 搜索框和按钮 */}
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
                  placeholder="搜索标题或指令编号..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") loadArchives();
                  }}
                />
                <span style={{ position: "absolute", left: 16, top: "50%", transform: "translateY(-50%)", fontSize: 18, opacity: 0.5 }}>🔍</span>
              </div>
              <button
                className="primary"
                onClick={loadArchives}
                disabled={loading}
                style={{ padding: "0 32px", height: 52, borderRadius: 12, fontSize: 15, fontWeight: 600, whiteSpace: "nowrap" }}
              >
                {loading ? "搜索中..." : "搜索"}
              </button>
            </div>

            {/* 日期过滤 */}
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
          </div>

          {/* 错误提示 */}
          {error && (
            <div style={{
              padding: "16px 20px",
              background: "#fef2f2",
              border: "1px solid #fecaca",
              borderRadius: 12,
              color: "#dc2626",
              fontSize: 14
            }}>
              {error}
            </div>
          )}

          {/* 档案列表 */}
          <div style={{ display: "grid", gap: 16 }}>
            {archives.map((archive) => (
              <div
                key={archive.archive_id}
                className="card animate-fade-in"
                style={{
                  padding: "16px",
                  background: "white",
                  border: "1px solid var(--border-color)",
                  borderRadius: 10,
                  cursor: "pointer",
                  transition: "all 0.2s"
                }}
                onClick={() => onOpenArchive(archive.archive_id, { kind: "docx" })}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = "#f8fafc";
                  e.currentTarget.style.borderColor = "var(--primary-color)";
                  e.currentTarget.style.transform = "translateY(-1px)";
                  e.currentTarget.style.boxShadow = "0 4px 12px rgba(0,0,0,0.08)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = "white";
                  e.currentTarget.style.borderColor = "var(--border-color)";
                  e.currentTarget.style.transform = "translateY(0px)";
                  e.currentTarget.style.boxShadow = "none";
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    {/* 标题或文件名 */}
                    {editingArchiveId === archive.archive_id ? (
                      <div onClick={(e) => e.stopPropagation()} style={{ marginBottom: 8 }}>
                        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
                          <input
                            type="text"
                            value={editingTitle}
                            onChange={(e) => setEditingTitle(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") saveTitle(archive.archive_id);
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
                            onClick={() => saveTitle(archive.archive_id)}
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
                      </div>
                    ) : (
                      <>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                          <div style={{
                            fontSize: 15,
                            fontWeight: 500,
                            color: "var(--text-main)"
                          }}>
                            {archive.title || archive.original_name}
                          </div>
                          {archive.title && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                startEditing(archive.archive_id, archive.title || "");
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
                        <div style={{ display: "flex", gap: 12, fontSize: 12, color: "var(--text-muted)" }}>
                          {archive.instruction_no && (
                            <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                              <span style={{ opacity: 0.5 }}>#</span> {archive.instruction_no}
                            </span>
                          )}
                          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                            <span style={{ opacity: 0.5 }}>📅</span> {formatDate(archive.zip_date)}
                          </span>
                          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                            <span style={{ opacity: 0.5 }}>📁</span> {archive.original_name}
                          </span>
                        </div>
                      </>
                    )}
                    {/* 指令内容 */}
                    {archive.content && editingArchiveId !== archive.archive_id && (
                      <div style={{
                        marginTop: 10,
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
                          display: expandedContent[archive.archive_id] ? "block" : "-webkit-box",
                          WebkitLineClamp: expandedContent[archive.archive_id] ? "unset" : 3,
                          WebkitBoxOrient: "vertical",
                          overflow: "hidden",
                          textOverflow: "ellipsis"
                        }}>
                          {archive.content}
                        </div>
                        {archive.content.length > 100 && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setExpandedContent(prev => ({
                                ...prev,
                                [archive.archive_id]: !prev[archive.archive_id]
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
                            {expandedContent[archive.archive_id] ? "收起 ▲" : "展开全部 ↓"}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* 空状态 */}
          {archives.length === 0 && !loading && !error && (
            <div style={{
              textAlign: "center",
              padding: "80px 20px",
              color: "var(--text-muted)",
              background: "white",
              borderRadius: 20,
              border: "1px dashed var(--border-color)"
            }}>
              <div style={{ fontSize: 40, marginBottom: 16 }}>📂</div>
              <div style={{ fontSize: 16, fontWeight: 500 }}>暂无档案数据</div>
              <div style={{ fontSize: 13, opacity: 0.7, marginTop: 4 }}>
                {searchQuery.trim() ? "没有找到匹配的档案" : "还没有导入任何档案"}
              </div>
            </div>
          )}

          {/* 加载状态 */}
          {loading && (
            <div style={{
              textAlign: "center",
              padding: "40px",
              color: "var(--text-muted)"
            }}>
              <div style={{ fontSize: 16 }}>加载中...</div>
            </div>
          )}

          {/* 加载更多状态 */}
          {loadingMore && !loading && (
            <div style={{
              textAlign: "center",
              padding: "20px",
              color: "var(--text-muted)"
            }}>
              <div style={{ fontSize: 14 }}>加载更多...</div>
            </div>
          )}

          {/* 没有更多数据 */}
          {!hasMore && archives.length > 0 && !loading && (
            <div style={{
              textAlign: "center",
              padding: "20px",
              fontSize: 13,
              color: "var(--text-muted)"
            }}>
              已加载全部数据
            </div>
          )}

          {/* 统计信息 */}
          {archives.length > 0 && !loading && (
            <div style={{
              padding: "20px",
              background: "white",
              borderRadius: 12,
              border: "1px solid var(--border-color)",
              fontSize: 13,
              color: "var(--text-muted)",
              textAlign: "center"
            }}>
              共找到 {archives.length} 个档案
            </div>
          )}
        </div>
      </div>
    </div>
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
