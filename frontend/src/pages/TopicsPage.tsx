import { useEffect, useState, useMemo } from "react";
import { invoke } from "../tauri";

type AnnotationRow = {
  annotation_id: string;
  target_kind: string;
  target_ref: string;
  locator: any;
  content: string;
  created_at: number;
  updated_at: number;
};

type ArchiveListItem = {
  archive_id: string;
  original_name: string;
  zip_date: number;
  imported_at: number;
  status: string;
  instruction_no?: string | null;
  title?: string | null;
  content?: string | null;
  issued_at?: string | null;
  archive_remark?: string | null;
  content_annotations?: AnnotationRow[];
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
  const [totalFetched, setTotalFetched] = useState(0); // 跟踪从后端获取的未过滤数据总量
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  // 标题编辑状态
  const [editingArchiveId, setEditingArchiveId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState<string>("");
  const [saving, setSaving] = useState(false);

  // 档案备注编辑状态
  const [editingRemarkId, setEditingRemarkId] = useState<string | null>(null);
  const [editingRemarkContent, setEditingRemarkContent] = useState<string>("");
  const [savingRemark, setSavingRemark] = useState(false);

  // 指令内容批注编辑状态
  const [editingAnnotationArchiveId, setEditingAnnotationArchiveId] = useState<string | null>(null);
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(null);
  const [editingAnnotationContent, setEditingAnnotationContent] = useState<string>("");
  const [savingAnnotation, setSavingAnnotation] = useState(false);

  // 指令内容展开状态
  const [expandedContent, setExpandedContent] = useState<Record<string, boolean>>({});

  const request = useMemo((): ListArchivesRequest => ({
    date_from: toTsStart(dateFrom),
    date_to: toTsEnd(dateTo),
    limit: 50,
    offset: offset,
  }), [dateFrom, dateTo, offset]);

  // 从 request 中获取 limit，用于判断是否还有更多数据
  const limit = 50;

  useEffect(() => {
    loadArchives();
  }, [request, refreshToken]);

  async function loadArchives() {
    try {
      setLoading(true);
      setError("");
      setOffset(0);
      setTotalFetched(0);
      setHasMore(true);

      // 清空搜索，避免混淆
      // 注意：我们不在后端搜索，只在前端过滤
      const result = await invoke<ArchiveListItem[]>("list_archives", { req: request });

      // 前端过滤：根据搜索关键词过滤标题、指令编号、备注和批注
      let filtered = result;
      if (searchQuery.trim()) {
        const query = searchQuery.trim().toLowerCase();
        filtered = filtered.filter(a => {
          // 匹配标题、文件名、指令编号
          const matchBasic =
            a.title?.toLowerCase().includes(query) ||
            a.original_name.toLowerCase().includes(query) ||
            a.instruction_no?.toLowerCase().includes(query);

          // 匹配档案备注
          const matchRemark = a.archive_remark?.toLowerCase().includes(query) ?? false;

          // 匹配指令内容批注
          const matchAnnotations = a.content_annotations?.some(ann =>
            ann.content.toLowerCase().includes(query)
          ) ?? false;

          return matchBasic || matchRemark || matchAnnotations;
        });
      }

      setArchives(filtered);
      setTotalFetched(result.length);
      // 如果返回数量少于 limit，说明没有更多数据了
      setHasMore(result.length >= limit);

      // 检查是否有重复
      const uniqueIds = new Set(filtered.map(a => a.archive_id));
      if (uniqueIds.size !== filtered.length) {
        console.warn(`[TopicsPage] 检测到重复数据！总记录 ${filtered.length}，唯一记录 ${uniqueIds.size}`);
      }
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
      const newRequest = { ...request, offset: totalFetched };
      const result = await invoke<ArchiveListItem[]>("list_archives", { req: newRequest });

      // 前端过滤：根据搜索关键词过滤标题、指令编号、备注和批注
      let filtered = result;
      if (searchQuery.trim()) {
        const query = searchQuery.trim().toLowerCase();
        filtered = filtered.filter(a => {
          // 匹配标题、文件名、指令编号
          const matchBasic =
            a.title?.toLowerCase().includes(query) ||
            a.original_name.toLowerCase().includes(query) ||
            a.instruction_no?.toLowerCase().includes(query);

          // 匹配档案备注
          const matchRemark = a.archive_remark?.toLowerCase().includes(query) ?? false;

          // 匹配指令内容批注
          const matchAnnotations = a.content_annotations?.some(ann =>
            ann.content.toLowerCase().includes(query)
          ) ?? false;

          return matchBasic || matchRemark || matchAnnotations;
        });
      }

      // 去重：避免添加已存在的档案
      setArchives(prev => {
        const existingIds = new Set(prev.map(a => a.archive_id));
        const newItems = filtered.filter(a => !existingIds.has(a.archive_id));
        return [...prev, ...newItems];
      });
      setTotalFetched(prev => prev + result.length);
      // 如果后端返回的数量少于 limit，说明没有更多数据了
      setHasMore(result.length >= limit);
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
  }, [loading, loadingMore, hasMore]);  // ❌ 移除 archives 依赖

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

  // 保存档案备注
  async function saveRemark(archiveId: string) {
    try {
      setSavingRemark(true);
      setError("");

      await invoke("create_or_update_annotation", {
        req: {
          archive_id: archiveId,
          target_kind: "archive_remark",
          target_ref: "whole",
          locator: null,
          content: editingRemarkContent.trim(),
        },
      });

      // 更新本地状态
      setArchives(prev =>
        prev.map(a =>
          a.archive_id === archiveId
            ? { ...a, archive_remark: editingRemarkContent.trim() || null }
            : a
        )
      );

      setEditingRemarkId(null);
      setEditingRemarkContent("");
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setSavingRemark(false);
    }
  }

  function startEditingRemark(archiveId: string, currentRemark: string | null) {
    setEditingRemarkId(archiveId);
    setEditingRemarkContent(currentRemark || "");
  }

  function cancelEditingRemark() {
    setEditingRemarkId(null);
    setEditingRemarkContent("");
  }

  // 保存指令内容批注
  async function saveAnnotation(archiveId: string, annotationId: string | null) {
    if (!editingAnnotationContent.trim()) {
      setError("批注内容不能为空");
      return;
    }
    try {
      setSavingAnnotation(true);
      setError("");

      if (annotationId) {
        // 更新现有批注
        await invoke("update_annotation", {
          req: {
            annotation_id: annotationId,
            content: editingAnnotationContent.trim(),
          },
        });
      } else {
        // 创建新批注
        await invoke("create_annotation", {
          req: {
            archive_id: archiveId,
            target_kind: "main_doc",
            target_ref: "content",
            locator: { type: "field", field_name: "content" },
            content: editingAnnotationContent.trim(),
          },
        });
      }

      // 重新加载档案列表以获取更新的批注
      await loadArchives();

      setEditingAnnotationArchiveId(null);
      setEditingAnnotationId(null);
      setEditingAnnotationContent("");
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setSavingAnnotation(false);
    }
  }

  function startEditingAnnotation(archiveId: string, annotationId: string | null, content: string) {
    setEditingAnnotationArchiveId(archiveId);
    setEditingAnnotationId(annotationId);
    setEditingAnnotationContent(content);
  }

  function cancelEditingAnnotation() {
    setEditingAnnotationArchiveId(null);
    setEditingAnnotationId(null);
    setEditingAnnotationContent("");
  }

  // 删除批注
  async function deleteAnnotation(annotationId: string) {
    try {
      setError("");
      await invoke("delete_annotation", { annotationId });
      // 重新加载档案列表
      await loadArchives();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  }

  function formatDate(ts: number): string {
    const d = new Date(ts * 1000);
    return d.toLocaleDateString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });
  }

  function formatIssuedAt(issuedAt: string | null): string {
    if (!issuedAt) return "";
    // issued_at 格式: "2023年10月1日"
    return issuedAt.replace(/年/g, "/").replace(/月/g, "/").replace(/日/g, "");
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
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    // 输入时不立即过滤，等待用户点击搜索按钮或按回车
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      loadArchives();
                    }
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
                            <span style={{ opacity: 0.5 }}>📅</span> {formatIssuedAt(archive.issued_at || null) || formatDate(archive.zip_date)}
                          </span>
                          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                            <span style={{ opacity: 0.5 }}>📁</span> {archive.original_name}
                          </span>
                        </div>
                      </>
                    )}
                    {/* 档案备注 */}
                    {editingArchiveId !== archive.archive_id && (
                      <div onClick={(e) => e.stopPropagation()} style={{ marginTop: 10 }}>
                        {editingRemarkId === archive.archive_id ? (
                          <div style={{
                            padding: "10px 12px",
                            background: "#fffbeb",
                            borderRadius: 8,
                            border: "2px solid #fbbf24"
                          }}>
                            <div style={{
                              fontSize: 11,
                              fontWeight: 600,
                              color: "#92400e",
                              marginBottom: 6,
                              textTransform: "uppercase"
                            }}>
                              档案备注
                            </div>
                            <textarea
                              value={editingRemarkContent}
                              onChange={(e) => setEditingRemarkContent(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" && e.metaKey) {
                                  saveRemark(archive.archive_id);
                                }
                                if (e.key === "Escape") cancelEditingRemark();
                              }}
                              placeholder="在此输入关于此档案的备注..."
                              autoFocus
                              style={{
                                width: "100%",
                                minHeight: "60px",
                                padding: "8px 12px",
                                fontSize: 13,
                                border: "1px solid #fbbf24",
                                borderRadius: 6,
                                outline: "none",
                                resize: "vertical",
                                fontFamily: "inherit"
                              }}
                            />
                            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                              <button
                                onClick={() => saveRemark(archive.archive_id)}
                                disabled={savingRemark}
                                style={{
                                  padding: "6px 12px",
                                  background: "#fbbf24",
                                  color: "#78350f",
                                  border: "none",
                                  borderRadius: 6,
                                  cursor: savingRemark ? "not-allowed" : "pointer",
                                  fontSize: 12,
                                  fontWeight: 600
                                }}
                              >
                                {savingRemark ? "保存中..." : "保存 (⌘+Enter)"}
                              </button>
                              <button
                                onClick={cancelEditingRemark}
                                disabled={savingRemark}
                                style={{
                                  padding: "6px 12px",
                                  background: "#e5e7eb",
                                  color: "#4b5563",
                                  border: "none",
                                  borderRadius: 6,
                                  cursor: savingRemark ? "not-allowed" : "pointer",
                                  fontSize: 12
                                }}
                              >
                                取消
                              </button>
                            </div>
                          </div>
                        ) : (
                          <>
                            {archive.archive_remark ? (
                              <div style={{
                                padding: "10px 12px",
                                background: "#fffbeb",
                                borderRadius: 8,
                                border: "1px solid #fde68a",
                                fontSize: 13,
                                color: "#92400e",
                                lineHeight: 1.6
                              }}>
                                <div style={{
                                  fontSize: 11,
                                  fontWeight: 600,
                                  color: "#92400e",
                                  marginBottom: 6,
                                  textTransform: "uppercase",
                                  display: "flex",
                                  justifyContent: "space-between",
                                  alignItems: "center"
                                }}>
                                  <span>档案备注</span>
                                  <button
                                    onClick={() => startEditingRemark(archive.archive_id, archive.archive_remark || null)}
                                    style={{
                                      padding: "2px 6px",
                                      background: "#fef3c7",
                                      border: "none",
                                      borderRadius: 4,
                                      cursor: "pointer",
                                      fontSize: 11,
                                      color: "#92400e",
                                      opacity: 0.8
                                    }}
                                  >
                                    ✏️ 编辑
                                  </button>
                                </div>
                                <div>{archive.archive_remark}</div>
                              </div>
                            ) : (
                              <button
                                onClick={() => startEditingRemark(archive.archive_id, null)}
                                style={{
                                  padding: "6px 10px",
                                  background: "#fef3c7",
                                  border: "1px dashed #fbbf24",
                                  borderRadius: 6,
                                  cursor: "pointer",
                                  fontSize: 12,
                                  color: "#92400e",
                                  textAlign: "left",
                                  opacity: 0.8
                                }}
                                onMouseEnter={(e) => {
                                  e.currentTarget.style.opacity = "1";
                                  e.currentTarget.style.background = "#fffbeb";
                                }}
                                onMouseLeave={(e) => {
                                  e.currentTarget.style.opacity = "0.8";
                                  e.currentTarget.style.background = "#fef3c7";
                                }}
                              >
                                + 添加档案备注
                              </button>
                            )}
                          </>
                        )}
                      </div>
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
                    {/* 指令内容批注 */}
                    {archive.content && editingArchiveId !== archive.archive_id && (
                      <div onClick={(e) => e.stopPropagation()} style={{ marginTop: 10 }}>
                        <div style={{
                          fontSize: 11,
                          fontWeight: 600,
                          color: "var(--text-muted)",
                          marginBottom: 6,
                          textTransform: "uppercase",
                          paddingLeft: 4
                        }}>
                          批注
                        </div>
                        {archive.content_annotations && archive.content_annotations.length > 0 && (
                          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            {archive.content_annotations.map((annotation) => (
                              <div
                                key={annotation.annotation_id}
                                style={{
                                  padding: "10px 12px",
                                  background: "#f0fdf4",
                                  borderRadius: 8,
                                  border: "1px solid #bbf7d0",
                                  fontSize: 13,
                                  color: "#166534",
                                  lineHeight: 1.6
                                }}
                              >
                                {editingAnnotationArchiveId === archive.archive_id && editingAnnotationId === annotation.annotation_id ? (
                                  <div>
                                    <textarea
                                      value={editingAnnotationContent}
                                      onChange={(e) => setEditingAnnotationContent(e.target.value)}
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter" && e.metaKey) {
                                          saveAnnotation(archive.archive_id, annotation.annotation_id);
                                        }
                                        if (e.key === "Escape") cancelEditingAnnotation();
                                      }}
                                      autoFocus
                                      style={{
                                        width: "100%",
                                        minHeight: "60px",
                                        padding: "8px 12px",
                                        fontSize: 13,
                                        border: "1px solid #22c55e",
                                        borderRadius: 6,
                                        outline: "none",
                                        resize: "vertical",
                                        fontFamily: "inherit",
                                        marginBottom: 8
                                      }}
                                    />
                                    <div style={{ display: "flex", gap: 8 }}>
                                      <button
                                        onClick={() => saveAnnotation(archive.archive_id, annotation.annotation_id)}
                                        disabled={savingAnnotation}
                                        style={{
                                          padding: "6px 12px",
                                          background: "#22c55e",
                                          color: "white",
                                          border: "none",
                                          borderRadius: 6,
                                          cursor: savingAnnotation ? "not-allowed" : "pointer",
                                          fontSize: 12,
                                          fontWeight: 600
                                        }}
                                      >
                                        {savingAnnotation ? "保存中..." : "保存"}
                                      </button>
                                      <button
                                        onClick={cancelEditingAnnotation}
                                        disabled={savingAnnotation}
                                        style={{
                                          padding: "6px 12px",
                                          background: "#e5e7eb",
                                          color: "#4b5563",
                                          border: "none",
                                          borderRadius: 6,
                                          cursor: savingAnnotation ? "not-allowed" : "pointer",
                                          fontSize: 12
                                        }}
                                      >
                                        取消
                                      </button>
                                    </div>
                                  </div>
                                ) : (
                                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                                    <div style={{ flex: 1 }}>{annotation.content}</div>
                                    <div style={{ display: "flex", gap: 4, marginLeft: 8 }}>
                                      <button
                                        onClick={() => startEditingAnnotation(archive.archive_id, annotation.annotation_id, annotation.content)}
                                        style={{
                                          padding: "2px 6px",
                                          background: "#dcfce7",
                                          border: "none",
                                          borderRadius: 4,
                                          cursor: "pointer",
                                          fontSize: 11,
                                          color: "#166534"
                                        }}
                                      >
                                        ✏️
                                      </button>
                                      <button
                                        onClick={() => deleteAnnotation(annotation.annotation_id)}
                                        style={{
                                          padding: "2px 6px",
                                          background: "#fee2e2",
                                          border: "none",
                                          borderRadius: 4,
                                          cursor: "pointer",
                                          fontSize: 11,
                                          color: "#dc2626"
                                        }}
                                      >
                                        🗑️
                                      </button>
                                    </div>
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                        {/* 添加新批注 */}
                        {editingAnnotationArchiveId === archive.archive_id && editingAnnotationId === "new" ? (
                          <div style={{
                            marginTop: 8,
                            padding: "10px 12px",
                            background: "#f0fdf4",
                            borderRadius: 8,
                            border: "2px solid #22c55e"
                          }}>
                            <textarea
                              value={editingAnnotationContent}
                              onChange={(e) => setEditingAnnotationContent(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" && e.metaKey) {
                                  saveAnnotation(archive.archive_id, null);
                                }
                                if (e.key === "Escape") cancelEditingAnnotation();
                              }}
                              placeholder="在此输入批注内容..."
                              autoFocus
                              style={{
                                width: "100%",
                                minHeight: "60px",
                                padding: "8px 12px",
                                fontSize: 13,
                                border: "1px solid #22c55e",
                                borderRadius: 6,
                                outline: "none",
                                resize: "vertical",
                                fontFamily: "inherit",
                                marginBottom: 8
                              }}
                            />
                            <div style={{ display: "flex", gap: 8 }}>
                              <button
                                onClick={() => saveAnnotation(archive.archive_id, null)}
                                disabled={savingAnnotation}
                                style={{
                                  padding: "6px 12px",
                                  background: "#22c55e",
                                  color: "white",
                                  border: "none",
                                  borderRadius: 6,
                                  cursor: savingAnnotation ? "not-allowed" : "pointer",
                                  fontSize: 12,
                                  fontWeight: 600
                                }}
                              >
                                {savingAnnotation ? "保存中..." : "保存 (⌘+Enter)"}
                              </button>
                              <button
                                onClick={cancelEditingAnnotation}
                                disabled={savingAnnotation}
                                style={{
                                  padding: "6px 12px",
                                  background: "#e5e7eb",
                                  color: "#4b5563",
                                  border: "none",
                                  borderRadius: 6,
                                  cursor: savingAnnotation ? "not-allowed" : "pointer",
                                  fontSize: 12
                                }}
                              >
                                取消
                              </button>
                            </div>
                          </div>
                        ) : (
                          <button
                            onClick={() => startEditingAnnotation(archive.archive_id, "new", "")}
                            style={{
                              marginTop: 8,
                              padding: "6px 10px",
                              background: "#dcfce7",
                              border: "1px dashed #22c55e",
                              borderRadius: 6,
                              cursor: "pointer",
                              fontSize: 12,
                              color: "#166534",
                              textAlign: "left",
                              opacity: 0.8
                            }}
                            onMouseEnter={(e) => {
                              e.currentTarget.style.opacity = "1";
                              e.currentTarget.style.background = "#f0fdf4";
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.opacity = "0.8";
                              e.currentTarget.style.background = "#dcfce7";
                            }}
                          >
                            + 添加批注
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
              <div style={{ marginBottom: 4 }}>
                {searchQuery.trim() ? `搜索结果: ${archives.length} 个档案` : `共找到 ${archives.length} 个档案`}
              </div>
              {(searchQuery.trim() || dateFrom || dateTo) && (
                <div style={{ fontSize: 11, color: "#f59e0b" }}>
                  {searchQuery.trim() && `🔍 搜索: "${searchQuery}" `}
                  {dateFrom && `📅 从: ${dateFrom} `}
                  {dateTo && `到: ${dateTo}`}
                  {` (点击右上角清空按钮重置)`}
                </div>
              )}
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
