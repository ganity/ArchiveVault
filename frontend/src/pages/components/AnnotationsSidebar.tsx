import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "../../tauri";

type Annotation = {
  annotation_id: string;
  archive_id: string;
  target_kind: "docx" | "pdf" | "media" | "excel";
  target_ref: string;
  locator: any;
  content: string;
  created_at: number;
};

type CreateReq = {
  archive_id: string;
  target_kind: string;
  target_ref: string;
  locator: any;
  content: string;
};

export default function AnnotationsSidebar({
  open,
  onClose,
  defaultScope,
  archiveId,
  currentTarget,
  onJump,
  draftTarget,
  activeAnnotationId,
  onActiveChange,
  onListChange,
}: {
  open: boolean;
  onClose?: () => void;
  defaultScope?: "archive" | "current";
  archiveId: string;
  currentTarget:
  | { kind: "docx"; block_id?: string }
  | { kind: "attachment"; file_id: string; file_type: string; page?: number | null }
  | null;
  draftTarget: CreateReq | null;
  onJump: (a: Annotation) => void;
  activeAnnotationId?: string | null;
  onActiveChange?: (id: string | null) => void;
  onListChange?: (items: Annotation[]) => void;
}) {
  const [list, setList] = useState<Annotation[]>([]);
  const [msg, setMsg] = useState("");
  const [text, setText] = useState("");
  const [scope, setScope] = useState<"current" | "all">(defaultScope === "archive" ? "all" : "current");
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  async function refresh() {
    const items = await invoke<Annotation[]>("list_annotations", { archiveId });
    setList(items);
    onListChange?.(items);
  }

  useEffect(() => {
    setMsg("");
    refresh().catch((e) => setMsg(String(e?.message ?? e)));
  }, [archiveId]);

  useEffect(() => {
    setScope(defaultScope === "archive" ? "all" : "current");
  }, [defaultScope, archiveId]);

  useEffect(() => {
    if (!open) return;
    // 打开抽屉时把光标放到输入框，便于快速添加批注
    setTimeout(() => taRef.current?.focus(), 0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (!activeAnnotationId) return;
    const el = document.querySelector(`[data-annotation-id="${activeAnnotationId}"]`);
    (el as any)?.scrollIntoView?.({ block: "center" });
  }, [open, activeAnnotationId, list]);

  const visible = useMemo(() => {
    if (scope === "all" || !currentTarget) return list;
    if (currentTarget.kind === "docx") {
      if (currentTarget.block_id) {
        return list.filter(
          (a) => a.target_kind === "docx" && a.locator?.block_id === currentTarget.block_id
        );
      }
      return list.filter((a) => a.target_kind === "docx");
    }
    // attachment
    if (currentTarget.file_type === "pdf") {
      // PDF：当前对象默认按文件过滤（页级/文件级都算）
      return list.filter((a) => a.target_ref === currentTarget.file_id);
    }
    return list.filter((a) => a.target_ref === currentTarget.file_id);
  }, [scope, list, currentTarget]);

  async function create() {
    if (!draftTarget) {
      setMsg("没有可创建的批注目标");
      return;
    }
    if (!text.trim()) {
      setMsg("批注内容不能为空");
      return;
    }
    setMsg("");
    try {
      await invoke("create_annotation", { req: { ...draftTarget, content: text } });
      setText("");
      await refresh();
    } catch (e: any) {
      setMsg(String(e?.message ?? e));
    }
  }

  const draftHint = useMemo(() => {
    if (!draftTarget) return "未选择批注目标";
    if (draftTarget.target_kind === "docx") {
      // 附加docx：target_ref != archive_id
      if (draftTarget.target_ref && draftTarget.target_ref !== draftTarget.archive_id) {
        const p = draftTarget.locator?.page;
        const para = draftTarget.locator?.para_idx;
        const img = draftTarget.locator?.image_index;
        const s = draftTarget.locator?.start;
        const e = draftTarget.locator?.end;
        if (typeof p === "number") return `目标：附加docx 第 ${p} 页`;
        if (typeof img === "number") return `目标：附加docx 图片 #${img + 1}`;
        if (typeof para === "number" && typeof s === "number" && typeof e === "number") {
          return `目标：附加docx 段落 #${para + 1} [${s},${e})`;
        }
        if (typeof para === "number") return `目标：附加docx 段落 #${para + 1}`;
        return "目标：附加docx（文件级）";
      }
      const b = draftTarget.locator?.block_id;
      const s = draftTarget.locator?.start;
      const e = draftTarget.locator?.end;
      const f = draftTarget.locator?.field_name;
      const fs = draftTarget.locator?.field_start;
      const fe = draftTarget.locator?.field_end;
      if (f && typeof fs === "number" && typeof fe === "number") return `目标：字段 ${f} 范围 [${fs},${fe})`;
      if (f) return `目标：字段 ${f}`;
      if (b && typeof s === "number" && typeof e === "number") {
        return `目标：段落 ${b} 范围 [${s},${e})`;
      }
      return `目标：主docx`;
    }
    if (draftTarget.target_kind === "pdf") {
      const p = draftTarget.locator?.page;
      return p === null ? "目标：PDF 文件级" : `目标：PDF 第 ${p} 页`;
    }
    if (draftTarget.target_kind === "media") {
      const ns = draftTarget.locator?.name_start;
      const ne = draftTarget.locator?.name_end;
      if (typeof ns === "number" && typeof ne === "number" && ne > ns) return `目标：文件名片段 [${ns},${ne})`;
      return "目标：附件文件级";
    }
    if (draftTarget.target_kind === "excel") {
      const sheet = draftTarget.locator?.sheet_name;
      const row = draftTarget.locator?.row;
      const col = draftTarget.locator?.col;
      if (sheet && typeof row === "number" && typeof col === "number") return `目标：Excel ${sheet} R${row + 1}C${col + 1}`;
      if (sheet && typeof row === "number") return `目标：Excel ${sheet} 第 ${row + 1} 行`;
      return "目标：Excel（文件级）";
    }
    return "目标：未知";
  }, [draftTarget]);

  async function del(id: string) {
    setMsg("");
    try {
      await invoke("delete_annotation", { annotationId: id });
      await refresh();
    } catch (e: any) {
      setMsg(String(e?.message ?? e));
    }
  }

  if (!open) return null;

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        height: "100%",
        width: 380,
        maxWidth: "92vw",
        background: "#ffffff",
        borderLeft: "1px solid var(--border-color)",
        boxShadow: "-4px 0 20px rgba(0,0,0,0.05)",
        display: "flex",
        flexDirection: "column",
        zIndex: 100,
        animation: "fadeIn 0.2s ease-out"
      }}
    >
      <div style={{
        padding: "16px 20px",
        borderBottom: "1px solid var(--border-color)",
        display: "flex",
        alignItems: "center",
        gap: 12,
        background: "#fff"
      }}>
        <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "var(--text-main)" }}>批注详情</h3>
        <button
          onClick={onClose}
          style={{
            marginLeft: "auto",
            padding: "4px 12px",
            fontSize: 13,
            background: "#f1f5f9",
            border: "none",
            borderRadius: 6,
            color: "var(--text-muted)"
          }}
        >
          关闭
        </button>
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: "20px" }}>
        {/* Scope Selector */}
        <div style={{ display: "flex", gap: 4, background: "#f1f5f9", padding: 4, borderRadius: 10, marginBottom: 20 }}>
          <button
            onClick={() => setScope("current")}
            disabled={scope === "current"}
            style={{
              flex: 1,
              border: "none",
              background: scope === "current" ? "white" : "transparent",
              color: scope === "current" ? "var(--primary-color)" : "var(--text-muted)",
              borderRadius: 7,
              height: 32,
              padding: "0 12px",
              fontSize: 13,
              fontWeight: 500,
              boxShadow: scope === "current" ? "0 1px 2px rgba(0,0,0,0.05)" : "none"
            }}
          >
            当前对象
          </button>
          <button
            onClick={() => setScope("all")}
            disabled={scope === "all"}
            style={{
              flex: 1,
              border: "none",
              background: scope === "all" ? "white" : "transparent",
              color: scope === "all" ? "var(--primary-color)" : "var(--text-muted)",
              borderRadius: 7,
              height: 32,
              padding: "0 12px",
              fontSize: 13,
              fontWeight: 500,
              boxShadow: scope === "all" ? "0 1px 2px rgba(0,0,0,0.05)" : "none"
            }}
          >
            本档案全部
          </button>
        </div>

        {/* Input Area */}
        <div className="card" style={{ padding: 16, marginBottom: 24, boxShadow: "0 2px 8px rgba(0,0,0,0.04)", border: "1px solid var(--border-color)" }}>
          <div style={{
            fontSize: 11,
            fontWeight: 700,
            color: draftTarget ? "var(--primary-color)" : "#94a3b8",
            textTransform: "uppercase",
            marginBottom: 8,
            display: "flex",
            alignItems: "center",
            gap: 6
          }}>
            <span style={{ opacity: 0.7 }}>🎯</span> {draftHint}
          </div>
          <textarea
            ref={taRef}
            rows={3}
            style={{
              width: "100%",
              padding: "10px 12px",
              borderRadius: 8,
              border: "1px solid var(--border-color)",
              fontSize: 14,
              fontFamily: "inherit",
              outline: "none",
              resize: "vertical",
              marginBottom: 12,
              background: "#fdfdfd"
            }}
            placeholder="在此输入您的批注内容..."
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button
            className="primary"
            onClick={create}
            style={{ width: "100%", height: 38, borderRadius: 8, fontSize: 13, fontWeight: 600 }}
          >
            添加批注
          </button>
          {msg ? (
            <div style={{
              marginTop: 10,
              padding: "8px 12px",
              borderRadius: 6,
              background: "#fef2f2",
              color: "#b91c1c",
              fontSize: 12,
              fontWeight: 500
            }}>
              {msg}
            </div>
          ) : null}
        </div>

        {/* List Section */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {visible.length > 0 ? (
            visible.map((a) => {
              const isActive = activeAnnotationId === a.annotation_id;
              return (
                <div
                  key={a.annotation_id}
                  data-annotation-id={a.annotation_id}
                  onClick={() => {
                    onActiveChange?.(a.annotation_id);
                    onJump(a);
                  }}
                  style={{
                    border: "1px solid",
                    borderColor: isActive ? "var(--primary-color)" : "var(--border-color)",
                    borderRadius: 12,
                    padding: 14,
                    background: isActive ? "#eff6ff" : "white",
                    cursor: "pointer",
                    transition: "all 0.2s ease",
                    position: "relative",
                    boxShadow: isActive ? "0 4px 12px rgba(37, 99, 235, 0.08)" : "none"
                  }}
                  onMouseEnter={(e) => {
                    if (!isActive) e.currentTarget.style.borderColor = "#cbd5e1";
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive) e.currentTarget.style.borderColor = "var(--border-color)";
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10, alignItems: "flex-start" }}>
                    <div style={{
                      display: "inline-flex",
                      alignItems: "center",
                      padding: "3px 8px",
                      background: isActive ? "var(--primary-color)" : "#f1f5f9",
                      color: isActive ? "white" : "var(--text-muted)",
                      borderRadius: 6,
                      fontSize: 11,
                      fontWeight: 600,
                      letterSpacing: "0.3px"
                    }}>
                      {formatTarget(a)}
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        del(a.annotation_id);
                      }}
                      style={{
                        padding: "4px 8px",
                        fontSize: 11,
                        color: "#ef4444",
                        border: "none",
                        background: "transparent",
                        opacity: 0.6,
                        transition: "opacity 0.2s"
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.opacity = "1"}
                      onMouseLeave={(e) => e.currentTarget.style.opacity = "0.6"}
                    >
                      删除
                    </button>
                  </div>
                  <div style={{
                    whiteSpace: "pre-wrap",
                    fontSize: 14,
                    color: "var(--text-main)",
                    lineHeight: 1.5,
                    fontWeight: isActive ? 500 : 400
                  }}>
                    {a.content}
                  </div>
                </div>
              );
            })
          ) : (
            <div style={{
              padding: "40px 20px",
              textAlign: "center",
              color: "#94a3b8",
              fontSize: 13
            }}>
              📭 暂无相关批注内容
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function formatTarget(a: Annotation) {
  if (a.target_kind === "docx") {
    // 附加docx：target_ref != archive_id
    if (a.target_ref && a.target_ref !== a.archive_id) {
      const p = a.locator?.page;
      const para = a.locator?.para_idx;
      const img = a.locator?.image_index;
      const s = a.locator?.start;
      const e = a.locator?.end;
      if (typeof p === "number") return `附加docx 第 ${p} 页`;
      if (typeof img === "number") return `附加docx 图片 #${img + 1}`;
      if (typeof para === "number" && typeof s === "number" && typeof e === "number") return `附加docx 段落 #${para + 1} [${s},${e})`;
      if (typeof para === "number") return `附加docx 段落 #${para + 1}`;
      return "附加docx";
    }
    const b = a.locator?.block_id;
    const s = a.locator?.start;
    const e = a.locator?.end;
    const f = a.locator?.field_name;
    const fs = a.locator?.field_start ?? a.locator?.start;
    const fe = a.locator?.field_end ?? a.locator?.end;
    if (f && typeof fs === "number" && typeof fe === "number") return `字段 ${f} [${fs},${fe})`;
    if (b && typeof s === "number" && typeof e === "number") return `段落 ${b} [${s},${e})`;
    if (b) return `段落 ${b}`;
    return "主docx";
  }
  if (a.target_kind === "pdf") {
    const p = a.locator?.page;
    return p === null ? "PDF 文件级" : `PDF 第 ${p} 页`;
  }
  if (a.target_kind === "excel") {
    const sheet = a.locator?.sheet_name;
    const row = a.locator?.row;
    const col = a.locator?.col;
    if (sheet && typeof row === "number" && typeof col === "number") return `Excel ${sheet} R${row + 1}C${col + 1}`;
    if (sheet && typeof row === "number") return `Excel ${sheet} 第 ${row + 1} 行`;
    return "Excel";
  }
  if (a.target_kind === "media") return "附件文件级";
  return a.target_kind;
}
