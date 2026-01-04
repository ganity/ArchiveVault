import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "../../tauri";
import AnnotationsSidebar from "./AnnotationsSidebar";
import DocxAttachmentPreview from "./DocxAttachmentPreview";
import ExcelViewer from "./ExcelViewer";
import PdfAllPagesViewer from "./PdfAllPagesViewer";
import TextHighlighter from "./TextHighlighter";

type ArchiveDetail = {
  archive: {
    archive_id: string;
    original_name: string;
    stored_path: string;
    zip_date: number;
    imported_at: number;
    status: string;
    error?: string | null;
  };
  main_doc?: {
    instruction_no: string;
    title: string;
    issued_at: string;
    content: string;
    field_block_map_json: string;
  } | null;
  attachments: {
    file_id: string;
    display_name: string;
    file_type: string;
    source_depth: number;
    container_virtual_path?: string | null;
    virtual_path: string;
    cached_path?: string | null;
  }[];
  annotations: any[];
};

type DocxBlock = { block_id: string; text: string };

type ViewMode = "overview" | "preview";

export default function ArchiveDetail({
  archiveId,
  open,
  onArchiveDeleted,
}: {
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
  onArchiveDeleted?: () => void | Promise<void>;
}) {
  const [detail, setDetail] = useState<ArchiveDetail | null>(null);
  const [blocks, setBlocks] = useState<DocxBlock[]>([]);
  const [selectedAttachmentId, setSelectedAttachmentId] = useState<string | null>(null);
  const [attachmentPreview, setAttachmentPreview] = useState<{ file_id: string; path: string } | null>(null);
  const [attachmentType, setAttachmentType] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmReparse, setConfirmReparse] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("overview");
  const [annotationsOpen, setAnnotationsOpen] = useState(false);
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(null);
  const [annotationsList, setAnnotationsList] = useState<any[]>([]);
  const [draftOverride, setDraftOverride] = useState<any | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; req: any } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const [docxExpanded, setDocxExpanded] = useState(false);
  const [docxSelection, setDocxSelection] = useState<{
    block_id: string;
    start: number;
    end: number;
  } | null>(null);
  const [focusDocxRange, setFocusDocxRange] = useState<{
    block_id: string;
    start: number;
    end: number;
  } | null>(null);
  const [focusFieldRange, setFocusFieldRange] = useState<{ field_name: string; start: number; end: number } | null>(null);
  const [focusAttachmentName, setFocusAttachmentName] = useState<{ file_id: string; ranges: { start: number; end: number }[] } | null>(
    null
  );
  const [excelFocus, setExcelFocus] = useState<{ file_id: string; sheet_name: string; row: number; col?: number } | null>(null);
  const [docxAttachmentFocus, setDocxAttachmentFocus] = useState<
    { file_id: string; page?: number; para_idx?: number; image_index?: number; ranges?: { start: number; end: number }[] } | null
  >(null);
  const [pdfPage, setPdfPage] = useState<number | null>(1);

  async function refreshDetailAndBlocks() {
    setMsg("");
    try {
      const d = await invoke<ArchiveDetail>("get_archive_detail", { archiveId });
      setDetail(d);
      setAnnotationsList(d.annotations ?? []);
    } catch (e: any) {
      const m = String(e?.message ?? e);
      // 档案已被删除/不存在：自动返回搜索，避免停留在空详情页
      if (m.includes("Query returned no rows") || m.includes("找不到档案") || m.includes("读取 archives 失败")) {
        setMsg("该档案已不存在（可能已删除或已重新导入生成新ID），将返回搜索页。");
        setTimeout(() => onArchiveDeleted?.(), 0);
        return;
      }
      setMsg(m);
    }
    try {
      const bs = await invoke<DocxBlock[]>("get_docx_blocks", { archiveId });
      setBlocks(bs);
    } catch (e: any) {
      setMsg(String(e?.message ?? e));
    }
  }

  const highlightsByBlock = useMemo(() => {
    const map: Record<string, { start: number; end: number }[]> = {};
    if (open?.kind === "docx" && open.block_id && open.highlights?.length) {
      map[open.block_id] = [...(map[open.block_id] ?? []), ...open.highlights];
    }
    if (focusDocxRange) {
      map[focusDocxRange.block_id] = [
        ...(map[focusDocxRange.block_id] ?? []),
        { start: focusDocxRange.start, end: focusDocxRange.end },
      ];
    }
    return map;
  }, [open]);

  const fieldHighlights = useMemo(() => {
    const out: Record<string, { start: number; end: number }[]> = {};
    if (open?.kind === "docx" && open.field_name && open.field_highlights?.length) {
      out[open.field_name] = [...(out[open.field_name] ?? []), ...open.field_highlights];
    }
    if (focusFieldRange) {
      out[focusFieldRange.field_name] = [
        ...(out[focusFieldRange.field_name] ?? []),
        { start: focusFieldRange.start, end: focusFieldRange.end },
      ];
    }
    return out;
  }, [open, focusFieldRange]);

  useEffect(() => {
    setConfirmDelete(false);
    setConfirmReparse(false);
    setAnnotationsOpen(false);
    setActiveAnnotationId(null);
    setDraftOverride(null);
    setContextMenu(null);
    setViewMode("overview");
    setDocxExpanded(false);
    setDocxSelection(null);
    setFocusDocxRange(null);
    setFocusFieldRange(null);
    setFocusAttachmentName(null);
    setExcelFocus(null);
    setDocxAttachmentFocus(null);
    refreshDetailAndBlocks();
  }, [archiveId]);

  useEffect(() => {
    function onMouseDown(e: globalThis.MouseEvent) {
      // macOS 上常见 ctrl+click 触发 contextmenu；不要在这种场景把菜单立刻关闭
      if (e.button !== 0) return; // 只处理左键
      if (e.ctrlKey || e.metaKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest?.("[data-context-menu]") || t.closest?.("[data-context-menu-root]"))) return;
      setContextMenu(null);
    }
    window.addEventListener("mousedown", onMouseDown, true);
    return () => window.removeEventListener("mousedown", onMouseDown, true);
  }, []);

  async function reparseThisArchive() {
    // Tauri WebView 下 window.confirm 可能被禁用，这里用二次点击确认
    if (!confirmReparse) {
      setConfirmReparse(true);
      setMsg("请再次点击“确认重新解析”以继续");
      return;
    }
    setMsg("");
    try {
      await invoke<string>("reparse_main_doc", { archiveId: archiveId });
      await refreshDetailAndBlocks();
      setMsg("重新解析完成");
    } catch (e: any) {
      setMsg(String(e?.message ?? e));
    } finally {
      setConfirmReparse(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    if (open.kind === "attachment") {
      setViewMode("overview");
      setDocxExpanded(false);
      setSelectedAttachmentId(open.file_id);
      setDocxSelection(null);
      setFocusDocxRange(null);
      setFocusFieldRange(null);
      setFocusAttachmentName({ file_id: open.file_id, ranges: open.highlights ?? [] });
      setExcelFocus(null);
      setDocxAttachmentFocus(null);

      // 延时滚动，确保 DOM 已渲染
      setTimeout(() => {
        const el = document.querySelector(`[data-file-id="${open.file_id}"]`);
        el?.scrollIntoView({ block: "center", behavior: "smooth" });
      }, 100);
      return;
    }
    if (open.kind === "docx") {
      setViewMode("overview");
      if (open.block_id || open.field_name) setDocxExpanded(true);
      if (open.field_name) {
        const el = document.querySelector(`[data-field-name="${open.field_name}"]`);
        el?.scrollIntoView({ block: "center" });
      }
      if (open.block_id) {
        // 需要等主文区域渲染后再滚动
        setTimeout(() => {
          const el = document.querySelector(`[data-block-id="${open.block_id}"]`);
          el?.scrollIntoView({ block: "center" });
        }, 0);
      }
      return;
    }
  }, [open]);

  useEffect(() => {
    if (!open || open.kind !== "annotation") return;
    setViewMode("overview");
    setDocxExpanded(false);
    setSelectedAttachmentId(null);
    setAttachmentType(null);
    setPdfPage(1);
    setExcelFocus(null);
    setDocxAttachmentFocus(null);
    setTimeout(() => {
      const a = (annotationsList ?? []).find((x: any) => x.annotation_id === open.annotation_id);
      setAnnotationsOpen(true);
      setActiveAnnotationId(open.annotation_id);
      if (a) jumpToAnnotation(a);
    }, 0);
  }, [open, annotationsList]);

  useEffect(() => {
    // 从搜索结果跳转到附件时，open effect 里只拿到了预览 path，附件类型需要等 detail 到位才能确定
    if (!detail || !selectedAttachmentId) return;
    const t = detail.attachments.find((x) => x.file_id === selectedAttachmentId)?.file_type ?? null;
    if (t && t !== attachmentType) setAttachmentType(t);
  }, [detail, selectedAttachmentId, attachmentType]);

  async function openAttachment(fileId: string) {
    setViewMode("preview");
    setDocxExpanded(false);
    setSelectedAttachmentId(fileId);
    setAttachmentPreview(null);
    setAttachmentType(null);
    setDocxSelection(null);
    setFocusDocxRange(null);
    setFocusFieldRange(null);
    setFocusAttachmentName(null);
    setExcelFocus(null);
    setDocxAttachmentFocus(null);
    setMsg("");
    try {
      const p = await invoke<{ file_id: string; path: string }>("get_attachment_preview_path", { fileId });
      setAttachmentPreview(p);
      const t = detail?.attachments.find((x) => x.file_id === fileId)?.file_type ?? null;
      setAttachmentType(t);
    } catch (e: any) {
      setMsg(String(e?.message ?? e));
    }
  }

  async function deleteThisArchive() {
    // Tauri WebView 下 window.confirm 可能被禁用，这里用二次点击确认
    if (!confirmDelete) {
      setConfirmDelete(true);
      setMsg("请再次点击“确认删除”以继续（将删除ZIP与所有解析/批注数据）");
      return;
    }
    setMsg("");
    try {
      await invoke("delete_archive", { archiveId: archiveId });
      setMsg("已删除该档案（请回到左侧列表刷新）");
      await onArchiveDeleted?.();
    } catch (e: any) {
      setMsg(String(e?.message ?? e));
    } finally {
      setConfirmDelete(false);
    }
  }

  async function cleanupThisArchiveCache() {
    setMsg("");
    try {
      const r = await invoke<string>("cleanup_archive_cache", { archiveId: archiveId });
      setMsg(r);
      setAttachmentPreview(null);
    } catch (e: any) {
      setMsg(String(e?.message ?? e));
    }
  }

  const currentAttachment = useMemo(() => {
    if (!detail || !selectedAttachmentId) return null;
    return detail.attachments.find((x) => x.file_id === selectedAttachmentId) ?? null;
  }, [detail, selectedAttachmentId]);

  function onDocxMouseUp(e: any) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) {
      setDocxSelection(null);
      return;
    }
    const range = sel.getRangeAt(0);
    const blockEl =
      (range.commonAncestorContainer as any)?.nodeType === 1
        ? (range.commonAncestorContainer as Element).closest?.("[data-block-id]")
        : (range.commonAncestorContainer as any)?.parentElement?.closest?.("[data-block-id]");
    if (!blockEl) {
      setDocxSelection(null);
      return;
    }
    const blockId = (blockEl as HTMLElement).getAttribute("data-block-id");
    if (!blockId) return;
    if (sel.isCollapsed) {
      setDocxSelection(null);
      return;
    }
    // 仅允许单一 block 内的选区
    const endBlockEl = (range.endContainer as any)?.nodeType === 1
      ? (range.endContainer as Element).closest?.("[data-block-id]")
      : (range.endContainer as any)?.parentElement?.closest?.("[data-block-id]");
    if (endBlockEl !== blockEl) {
      setDocxSelection(null);
      setMsg("批注选区需在同一段落内");
      return;
    }
    const pre = document.createRange();
    pre.setStart(blockEl, 0);
    pre.setEnd(range.startContainer, range.startOffset);
    const start = pre.toString().length;
    const selectedText = range.toString();
    const end = start + selectedText.length;
    const blockTextLen = (blockEl.textContent ?? "").length;
    if (end > blockTextLen) {
      setDocxSelection(null);
      return;
    }
    setDocxSelection({ block_id: blockId, start, end });
    setFocusDocxRange(null);
  }

  const draftTarget = useMemo(() => {
    if (draftOverride) return draftOverride;
    // docx 选区优先
    if (docxSelection) {
      return {
        archive_id: archiveId,
        target_kind: "docx",
        target_ref: archiveId,
        locator: docxSelection,
        content: "",
      };
    }
    // 附件批注
    if (selectedAttachmentId && attachmentType) {
      if (attachmentType === "pdf") {
        return {
          archive_id: archiveId,
          target_kind: "pdf",
          target_ref: selectedAttachmentId,
          locator: { page: pdfPage },
          content: "",
        };
      }
      if (attachmentType === "docx_other") {
        return {
          archive_id: archiveId,
          target_kind: "docx",
          target_ref: selectedAttachmentId,
          locator: { docx_kind: "attachment" },
          content: "",
        };
      }
      return {
        archive_id: archiveId,
        target_kind: "media",
        target_ref: selectedAttachmentId,
        locator: {},
        content: "",
      };
    }
    return null;
  }, [archiveId, docxSelection, selectedAttachmentId, attachmentType, pdfPage, draftOverride]);

  const annoByDocxBlock = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const a of annotationsList ?? []) {
      if (a.target_kind !== "docx") continue;
      const b = a.locator?.block_id;
      if (!b) continue;
      m.set(b, [...(m.get(b) ?? []), a]);
    }
    return m;
  }, [annotationsList]);

  const annoByField = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const a of annotationsList ?? []) {
      if (a.target_kind !== "docx") continue;
      const f = a.locator?.field_name;
      if (!f) continue;
      m.set(f, [...(m.get(f) ?? []), a]);
    }
    return m;
  }, [annotationsList]);

  const annoByAttachment = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const a of annotationsList ?? []) {
      if (
        a.target_kind === "pdf" ||
        a.target_kind === "media" ||
        a.target_kind === "excel" ||
        (a.target_kind === "docx" && a.target_ref && a.target_ref !== archiveId)
      ) {
        const id = a.target_ref;
        if (!id) continue;
        m.set(id, [...(m.get(id) ?? []), a]);
      }
    }
    return m;
  }, [annotationsList, archiveId]);

  function openContextAdd(req: any, x: number, y: number) {
    setContextMenu({ x, y, req });
  }

  function beginAnnotate(req: any) {
    // 让“当前对象”与 draftTarget 一致，避免用户感觉对象没选对
    if (req?.target_kind === "pdf" || req?.target_kind === "excel" || req?.target_kind === "media") {
      const fileId = req?.target_ref;
      if (typeof fileId === "string" && fileId) {
        setSelectedAttachmentId(fileId);
        const ft = detail?.attachments?.find((x) => x.file_id === fileId)?.file_type ?? null;
        if (req?.target_kind === "pdf") {
          setAttachmentType("pdf");
          const p = req?.locator?.page;
          if (typeof p === "number" || p === null) setPdfPage(p);
        } else if (req?.target_kind === "excel") {
          setAttachmentType("excel");
        } else {
          setAttachmentType(ft ?? "other");
        }
      }
    } else {
      // docx 类批注：清理附件上下文，避免“当前对象”落在旧附件上
      if (req?.target_kind === "docx" && req?.target_ref && req?.target_ref !== archiveId) {
        // 附加docx
        const fileId = req.target_ref;
        setSelectedAttachmentId(fileId);
        setAttachmentType("docx_other");
      } else {
        setSelectedAttachmentId(null);
        setAttachmentType(null);
        setPdfPage(1);
      }
    }
    setDraftOverride(req);
    setAnnotationsOpen(true);
    setContextMenu(null);
    setActiveAnnotationId(null);
  }

  function getSelectionRangeWithin(el: Element): { start: number; end: number } | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const startEl =
      (range.startContainer as any)?.nodeType === 1
        ? (range.startContainer as Element)
        : (range.startContainer as any)?.parentElement;
    const endEl =
      (range.endContainer as any)?.nodeType === 1
        ? (range.endContainer as Element)
        : (range.endContainer as any)?.parentElement;
    if (!startEl || !endEl) return null;
    if (!el.contains(startEl) || !el.contains(endEl)) return null;

    const pre = document.createRange();
    pre.setStart(el, 0);
    pre.setEnd(range.startContainer, range.startOffset);
    const start = pre.toString().length;
    const selectedText = range.toString();
    const end = start + selectedText.length;
    const total = (el.textContent ?? "").length;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    if (start < 0 || end > total) return null;
    return { start, end };
  }

  function jumpToAnnotation(a: any) {
    if (a.target_kind === "docx") {
      // 附加docx：target_ref 为 file_id
      if (a.target_ref && a.target_ref !== archiveId) {
        const fileId = a.target_ref;
        setViewMode("overview");
        setSelectedAttachmentId(fileId);
        setAttachmentType("docx_other");
        setPdfPage(1);
        setExcelFocus(null);
        const p = a.locator?.page;
        const paraIdx = a.locator?.para_idx;
        const imgIdx = a.locator?.image_index;
        const s = a.locator?.start;
        const e = a.locator?.end;
        setDocxAttachmentFocus({
          file_id: fileId,
          page: typeof p === "number" ? p : undefined,
          para_idx: typeof paraIdx === "number" ? paraIdx : undefined,
          image_index: typeof imgIdx === "number" ? imgIdx : undefined,
          ranges: typeof s === "number" && typeof e === "number" && e > s ? [{ start: s, end: e }] : undefined,
        });
        setTimeout(() => {
          const el = document.querySelector(`[data-file-id="${fileId}"]`);
          el?.scrollIntoView({ block: "center" });
        }, 0);
        return;
      }
      setViewMode("overview");
      setDocxExpanded(true);
      const blockId = a.locator?.block_id;
      const start = a.locator?.start;
      const end = a.locator?.end;
      const fieldName = a.locator?.field_name;
      const fs = a.locator?.field_start ?? a.locator?.start;
      const fe = a.locator?.field_end ?? a.locator?.end;
      if (fieldName && typeof fs === "number" && typeof fe === "number" && fe > fs) {
        setFocusFieldRange({ field_name: fieldName, start: fs, end: fe });
        setTimeout(() => {
          const el = document.querySelector(`[data-field-name="${fieldName}"]`);
          el?.scrollIntoView({ block: "center" });
        }, 0);
        return;
      }
      if (fieldName) {
        // 没有选区范围时仍然能定位字段
        const v = (detail?.main_doc as any)?.[fieldName] as string | undefined;
        if (typeof v === "string" && v.length) {
          setFocusFieldRange({ field_name: fieldName, start: 0, end: v.length });
        } else {
          setFocusFieldRange(null);
        }
        setTimeout(() => {
          const el = document.querySelector(`[data-field-name="${fieldName}"]`);
          el?.scrollIntoView({ block: "center" });
        }, 0);
        return;
      }
      if (blockId && typeof start === "number" && typeof end === "number" && end > start) {
        setFocusDocxRange({ block_id: blockId, start, end });
      } else {
        setFocusDocxRange(null);
      }
      if (blockId) {
        setTimeout(() => {
          const el = document.querySelector(`[data-block-id="${blockId}"]`);
          el?.scrollIntoView({ block: "center" });
        }, 0);
      }
      return;
    }
    if (a.target_kind === "pdf") {
      const fileId = a.target_ref;
      // 不跳转到“附件预览”，留在概览并定位到对应页/文件
      setViewMode("overview");
      setSelectedAttachmentId(fileId);
      setAttachmentType("pdf");
      const p = a.locator?.page;
      if (typeof p === "number" || p === null) setPdfPage(p);
      setTimeout(() => {
        const card = document.querySelector(`[data-file-id="${fileId}"]`);
        card?.scrollIntoView({ block: "center" });
        if (typeof p === "number") {
          const anchor = document.getElementById(pdfAnchorPrefix(fileId) + "-p-" + p);
          anchor?.scrollIntoView({ block: "start" });
        }
      }, 0);
      return;
    }
    if (a.target_kind === "media") {
      const fileId = a.target_ref;
      const ns = a.locator?.name_start;
      const ne = a.locator?.name_end;
      if (typeof ns === "number" && typeof ne === "number" && ne > ns) {
        setViewMode("overview");
        setFocusAttachmentName({ file_id: fileId, ranges: [{ start: ns, end: ne }] });
        setTimeout(() => {
          const el = document.querySelector(`[data-file-id="${fileId}"]`);
          el?.scrollIntoView({ block: "center" });
        }, 0);
        return;
      }
      // 文件级批注：留在概览并定位附件卡片（高亮整个文件名）
      setViewMode("overview");
      const dn = detail?.attachments?.find((x) => x.file_id === fileId)?.display_name ?? "";
      if (dn) setFocusAttachmentName({ file_id: fileId, ranges: [{ start: 0, end: dn.length }] });
      setTimeout(() => {
        const el = document.querySelector(`[data-file-id="${fileId}"]`);
        el?.scrollIntoView({ block: "center" });
      }, 0);
      return;
    }
    if (a.target_kind === "excel") {
      const fileId = a.target_ref;
      // 留在概览；定位到附件卡片（Excel 内定位暂在放大预览中更准确）
      setViewMode("overview");
      setSelectedAttachmentId(fileId);
      setAttachmentType("excel");
      const sheet = a.locator?.sheet_name ?? "";
      const row = a.locator?.row;
      const col = a.locator?.col;
      if (sheet && typeof row === "number") {
        setExcelFocus({ file_id: fileId, sheet_name: sheet, row, col: typeof col === "number" ? col : undefined });
      }
      setTimeout(() => {
        const el = document.querySelector(`[data-file-id="${fileId}"]`);
        el?.scrollIntoView({ block: "center" });
      }, 0);
      return;
    }
  }

  return (
    <div style={{ height: "100%", position: "relative", minWidth: 0, display: "flex", flexDirection: "column", background: "var(--bg-color)" }}>
      <div
        style={{
          padding: "12px 20px",
          background: "white",
          borderBottom: "1px solid var(--border-color)",
          display: "flex",
          alignItems: "center",
          gap: 16,
          flexWrap: "wrap",
          boxShadow: "0 1px 2px rgba(0,0,0,0.03)"
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.5px" }}>当前档案</div>
          <div style={{ fontWeight: 600, fontSize: 15, color: "var(--text-main)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {detail?.archive.original_name ?? archiveId}
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {viewMode !== "overview" ? <button onClick={() => setViewMode("overview")}>← 返回概览</button> : null}

          <div style={{ height: 20, width: 1, background: "var(--border-color)", margin: "0 4px" }} />

          {confirmReparse ? (
            <div style={{ display: "flex", gap: 6, alignItems: "center", background: "#fffbeb", padding: "4px 8px", borderRadius: 8, border: "1px solid #fef3c7" }}>
              <span style={{ fontSize: 12, color: "#92400e", fontWeight: 500 }}>确认重新解析？</span>
              <button onClick={reparseThisArchive} style={{ padding: "4px 10px", fontSize: 12, background: "#f59e0b", borderColor: "#f59e0b", color: "white" }}>确认</button>
              <button onClick={() => { setConfirmReparse(false); setMsg(""); }} style={{ padding: "4px 10px", fontSize: 12 }}>取消</button>
            </div>
          ) : (
            <button onClick={reparseThisArchive} title="重新从 ZIP 中提取内容">重新解析</button>
          )}

          {confirmDelete ? (
            <div style={{ display: "flex", gap: 6, alignItems: "center", background: "#fef2f2", padding: "4px 8px", borderRadius: 8, border: "1px solid #fee2e2" }}>
              <span style={{ fontSize: 12, color: "#b91c1c", fontWeight: 500 }}>确认彻底删除？</span>
              <button onClick={deleteThisArchive} style={{ padding: "4px 10px", fontSize: 12, background: "#ef4444", borderColor: "#ef4444", color: "white" }}>删除</button>
              <button onClick={() => { setConfirmDelete(false); setMsg(""); }} style={{ padding: "4px 10px", fontSize: 12 }}>取消</button>
            </div>
          ) : (
            <button onClick={deleteThisArchive} style={{ color: "#ef4444" }}>删除档案</button>
          )}

          <div style={{ height: 20, width: 1, background: "var(--border-color)", margin: "0 4px" }} />

          <button
            className={annotationsOpen ? "primary" : ""}
            onClick={() => setAnnotationsOpen((v) => !v)}
          >
            {annotationsOpen ? "隐藏批注" : "查看批注"}
          </button>
        </div>
      </div>

      {msg ? (
        <div style={{
          padding: "10px 20px",
          background: msg.includes("成功") || msg.includes("完成") ? "#f0fdf4" : "#fff1f2",
          borderBottom: "1px solid var(--border-color)",
          fontSize: 13,
          color: msg.includes("成功") || msg.includes("完成") ? "#166534" : "#991b1b",
          fontWeight: 500
        }}>
          {msg}
        </div>
      ) : null}

      <div
        style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 12, background: "#fafafa" }}
      >
        {viewMode === "overview" ? (
          <div style={{ display: "grid", gap: 14, maxWidth: 1100 }}>
            <div style={{ minWidth: 0 }}>
              <h3 style={{ marginTop: 0 }}>详情</h3>
              {detail?.main_doc ? (
                <div style={{ border: "1px solid #eee", borderRadius: 12, padding: 12, background: "#fff" }}>
                  <div style={{ display: "grid", gap: 12 }}>
                    <div
                      data-field-name="instruction_no"
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const valueEl = (e.currentTarget as HTMLElement).querySelector("[data-field-value]") as HTMLElement | null;
                        const r = valueEl ? getSelectionRangeWithin(valueEl) : null;
                        const locator = r
                          ? { field_name: "instruction_no", field_start: r.start, field_end: r.end }
                          : { field_name: "instruction_no" };
                        openContextAdd(
                          { archive_id: archiveId, target_kind: "docx", target_ref: archiveId, locator, content: "" },
                          e.clientX,
                          e.clientY
                        );
                      }}
                      onClick={() => {
                        const items = annoByField.get("instruction_no") ?? [];
                        if (!items.length) return;
                        setAnnotationsOpen(true);
                        setActiveAnnotationId(items[0].annotation_id);
                      }}
                      style={{ cursor: (annoByField.get("instruction_no") ?? []).length ? "pointer" : "default" }}
                    >
                      <div style={{ fontSize: 12, opacity: 0.7 }}>指令编号</div>
                      <div data-field-value>
                        <TextHighlighter text={detail.main_doc.instruction_no} ranges={fieldHighlights["instruction_no"] ?? []} />
                      </div>
                      {(annoByField.get("instruction_no") ?? []).length ? (
                        <div style={{ marginTop: 6, fontSize: 12, color: "#92400e" }}>
                          已批注 {(annoByField.get("instruction_no") ?? []).length} 条（点击打开）
                        </div>
                      ) : null}
                    </div>
                    <div
                      data-field-name="title"
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const valueEl = (e.currentTarget as HTMLElement).querySelector("[data-field-value]") as HTMLElement | null;
                        const r = valueEl ? getSelectionRangeWithin(valueEl) : null;
                        const locator = r ? { field_name: "title", field_start: r.start, field_end: r.end } : { field_name: "title" };
                        openContextAdd(
                          { archive_id: archiveId, target_kind: "docx", target_ref: archiveId, locator, content: "" },
                          e.clientX,
                          e.clientY
                        );
                      }}
                      onClick={() => {
                        const items = annoByField.get("title") ?? [];
                        if (!items.length) return;
                        setAnnotationsOpen(true);
                        setActiveAnnotationId(items[0].annotation_id);
                      }}
                      style={{ cursor: (annoByField.get("title") ?? []).length ? "pointer" : "default" }}
                    >
                      <div style={{ fontSize: 12, opacity: 0.7 }}>指令标题</div>
                      <div data-field-value>
                        <TextHighlighter text={detail.main_doc.title} ranges={fieldHighlights["title"] ?? []} />
                      </div>
                      {(annoByField.get("title") ?? []).length ? (
                        <div style={{ marginTop: 6, fontSize: 12, color: "#92400e" }}>
                          已批注 {(annoByField.get("title") ?? []).length} 条（点击打开）
                        </div>
                      ) : null}
                    </div>
                    <div
                      data-field-name="issued_at"
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const valueEl = (e.currentTarget as HTMLElement).querySelector("[data-field-value]") as HTMLElement | null;
                        const r = valueEl ? getSelectionRangeWithin(valueEl) : null;
                        const locator = r
                          ? { field_name: "issued_at", field_start: r.start, field_end: r.end }
                          : { field_name: "issued_at" };
                        openContextAdd(
                          { archive_id: archiveId, target_kind: "docx", target_ref: archiveId, locator, content: "" },
                          e.clientX,
                          e.clientY
                        );
                      }}
                      onClick={() => {
                        const items = annoByField.get("issued_at") ?? [];
                        if (!items.length) return;
                        setAnnotationsOpen(true);
                        setActiveAnnotationId(items[0].annotation_id);
                      }}
                      style={{ cursor: (annoByField.get("issued_at") ?? []).length ? "pointer" : "default" }}
                    >
                      <div style={{ fontSize: 12, opacity: 0.7 }}>下发时间</div>
                      <div data-field-value>
                        <TextHighlighter text={detail.main_doc.issued_at} ranges={fieldHighlights["issued_at"] ?? []} />
                      </div>
                      {(annoByField.get("issued_at") ?? []).length ? (
                        <div style={{ marginTop: 6, fontSize: 12, color: "#92400e" }}>
                          已批注 {(annoByField.get("issued_at") ?? []).length} 条（点击打开）
                        </div>
                      ) : null}
                    </div>
                    <div
                      data-field-name="content"
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const valueEl = (e.currentTarget as HTMLElement).querySelector("[data-field-value]") as HTMLElement | null;
                        const r = valueEl ? getSelectionRangeWithin(valueEl) : null;
                        const locator = r ? { field_name: "content", field_start: r.start, field_end: r.end } : { field_name: "content" };
                        openContextAdd(
                          { archive_id: archiveId, target_kind: "docx", target_ref: archiveId, locator, content: "" },
                          e.clientX,
                          e.clientY
                        );
                      }}
                      onClick={() => {
                        const items = annoByField.get("content") ?? [];
                        if (!items.length) return;
                        setAnnotationsOpen(true);
                        setActiveAnnotationId(items[0].annotation_id);
                      }}
                      style={{ cursor: (annoByField.get("content") ?? []).length ? "pointer" : "default" }}
                    >
                      <div style={{ fontSize: 12, opacity: 0.7 }}>指令内容（预览）</div>
                      <div data-field-value>
                        <TextHighlighter text={detail.main_doc.content} ranges={fieldHighlights["content"] ?? []} />
                      </div>
                      {(annoByField.get("content") ?? []).length ? (
                        <div style={{ marginTop: 6, fontSize: 12, color: "#92400e" }}>
                          已批注 {(annoByField.get("content") ?? []).length} 条（点击打开）
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              ) : (
                <div style={{ opacity: 0.7 }}>主文加载中...</div>
              )}
            </div>

            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <h3 style={{ marginTop: 0, marginBottom: 0 }}>主文（可批注）</h3>
                <button
                  onClick={() => {
                    setDocxExpanded((v) => !v);
                    if (!docxExpanded) {
                      setTimeout(() => {
                        const top = document.getElementById("docx-preview-top");
                        top?.scrollIntoView({ block: "start" });
                      }, 0);
                    }
                  }}
                >
                  {docxExpanded ? "收起" : "展开"}
                </button>
              </div>
              <div id="docx-preview-top" />
              {docxExpanded ? (
                <div
                  style={{
                    marginTop: 10,
                    border: "1px solid #eee",
                    borderRadius: 12,
                    padding: 12,
                    background: "#fff",
                  }}
                  onMouseUp={onDocxMouseUp}
                >
                  {docxSelection ? (
                    <div
                      style={{
                        marginBottom: 10,
                        padding: 10,
                        border: "1px solid #fde68a",
                        borderRadius: 10,
                        background: "#fffbeb",
                      }}
                    >
                      已选择段落 {docxSelection.block_id} 文本范围 [{docxSelection.start},{docxSelection.end})
                    </div>
                  ) : null}
                  <div style={{ display: "grid", gap: 10 }}>
                    {blocks.map((b) => (
                      <div key={b.block_id} style={{ padding: 12, border: "1px solid #eee", borderRadius: 12, background: "#fff" }}>
                        <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>{b.block_id}</div>
                        <div
                          data-block-id={b.block_id}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            const el = e.currentTarget;
                            const r = getSelectionRangeWithin(el);
                            const locator = r
                              ? { block_id: b.block_id, start: r.start, end: r.end }
                              : { block_id: b.block_id };
                            openContextAdd(
                              { archive_id: archiveId, target_kind: "docx", target_ref: archiveId, locator, content: "" },
                              e.clientX,
                              e.clientY
                            );
                          }}
                          onClick={() => {
                            const items = annoByDocxBlock.get(b.block_id) ?? [];
                            if (!items.length) return;
                            setAnnotationsOpen(true);
                            setActiveAnnotationId(items[0].annotation_id);
                          }}
                          style={{ cursor: (annoByDocxBlock.get(b.block_id) ?? []).length ? "pointer" : "default" }}
                        >
                          <TextHighlighter text={b.text} ranges={(highlightsByBlock as any)[b.block_id] ?? []} />
                          {(annoByDocxBlock.get(b.block_id) ?? []).length ? (
                            <div style={{ marginTop: 6, fontSize: 12, color: "#92400e" }}>
                              已批注 {(annoByDocxBlock.get(b.block_id) ?? []).length} 条（点击打开）
                            </div>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>展开后可查看全文并选择文本范围添加批注。</div>
              )}
            </div>

            <div style={{ minWidth: 0 }}>
              <h3 style={{ marginTop: 0 }}>附件（文件名下方直接预览）</h3>
              {detail ? (
                <div style={{ display: "grid", gap: 10 }}>
                  {groupAttachments(detail.attachments).map((g) => (
                    <div key={g.key} style={{ border: "1px solid #eee", borderRadius: 12, padding: 12, background: "#fff" }}>
                      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>{g.title}</div>
                      <div style={{ display: "grid", gap: 10 }}>
                        {g.items.map((a) => (
                          <div
                            key={a.file_id}
                            data-file-id={a.file_id}
                            style={{ border: "1px solid #eee", borderRadius: 12, padding: 10 }}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              // 如果用户在文件名里选择了部分文字，则按“文件名范围批注”；否则按“文件级批注”
                              const nameEl = (e.currentTarget as HTMLElement).querySelector("[data-file-name]") as HTMLElement | null;
                              const r = nameEl ? getSelectionRangeWithin(nameEl) : null;
                              if (r) {
                                // 文件名选区：统一用 media + name_start/name_end（用于高亮文件名片段）
                                openContextAdd(
                                  {
                                    archive_id: archiveId,
                                    target_kind: "media",
                                    target_ref: a.file_id,
                                    locator: { name_start: r.start, name_end: r.end },
                                    content: "",
                                  },
                                  e.clientX,
                                  e.clientY
                                );
                                return;
                              }
                              // 文件级：PDF 用 pdf(file-level)，Excel 用 excel(file-level)，其余用 media(file-level)
                              if (a.file_type === "pdf") {
                                openContextAdd(
                                  { archive_id: archiveId, target_kind: "pdf", target_ref: a.file_id, locator: { page: null }, content: "" },
                                  e.clientX,
                                  e.clientY
                                );
                                return;
                              }
                              if (a.file_type === "excel") {
                                openContextAdd(
                                  { archive_id: archiveId, target_kind: "excel", target_ref: a.file_id, locator: {}, content: "" },
                                  e.clientX,
                                  e.clientY
                                );
                                return;
                              }
                              openContextAdd(
                                { archive_id: archiveId, target_kind: "media", target_ref: a.file_id, locator: {}, content: "" },
                                e.clientX,
                                e.clientY
                              );
                            }}
                          >
                            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
                              <div style={{ minWidth: 0 }}>
                                <div style={{ fontSize: 12, opacity: 0.7 }}>{a.file_type}</div>
                                <div
                                  data-file-name
                                  style={{ fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                                  onContextMenu={(e) => {
                                    // 标题右键：若未选中任何文字，则默认对整个文件名创建“文件名批注”，便于定位
                                    e.preventDefault();
                                    e.stopPropagation();
                                    const el = e.currentTarget as HTMLElement;
                                    const r = getSelectionRangeWithin(el);
                                    const dn = detail?.attachments?.find((x) => x.file_id === a.file_id)?.display_name ?? a.display_name ?? "";
                                    const locator = r
                                      ? { name_start: r.start, name_end: r.end }
                                      : { name_start: 0, name_end: dn.length };
                                    openContextAdd(
                                      { archive_id: archiveId, target_kind: "media", target_ref: a.file_id, locator, content: "" },
                                      e.clientX,
                                      e.clientY
                                    );
                                  }}
                                  onClick={() => {
                                    const items = annoByAttachment.get(a.file_id) ?? [];
                                    if (!items.length) return;
                                    setAnnotationsOpen(true);
                                    setActiveAnnotationId(items[0].annotation_id);
                                  }}
                                >
                                  <TextHighlighter
                                    text={a.display_name}
                                    ranges={[
                                      ...(open?.kind === "attachment" && open.file_id === a.file_id && open.highlights?.length ? open.highlights : []),
                                      ...(focusAttachmentName?.file_id === a.file_id ? focusAttachmentName.ranges : []),
                                    ]}
                                  />
                                </div>
                                {(annoByAttachment.get(a.file_id) ?? []).length ? (
                                  <div style={{ marginTop: 6, fontSize: 12, color: "#92400e" }}>
                                    已批注 {(annoByAttachment.get(a.file_id) ?? []).length} 条（点击打开）
                                  </div>
                                ) : null}
                              </div>
                              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                                <button onClick={() => openAttachment(a.file_id)}>放大预览</button>
                              </div>
                            </div>

                            <div style={{ marginTop: 8 }}>
                              <InlineAttachmentPreview
                                fileId={a.file_id}
                                fileType={a.file_type}
                                onPdfPageContextMenu={(page, x, y) => {
                                  openContextAdd(
                                    { archive_id: archiveId, target_kind: "pdf", target_ref: a.file_id, locator: { page }, content: "" },
                                    x,
                                    y
                                  );
                                }}
                                onPdfPageClick={(page) => {
                                  const annPages = buildPdfAnnotatedPages(annoByAttachment.get(a.file_id) ?? []);
                                  setSelectedAttachmentId(a.file_id);
                                  setAttachmentType("pdf");
                                  setPdfPage(page);
                                  const ids = annPages?.[page] ?? [];
                                  if (ids.length) {
                                    setAnnotationsOpen(true);
                                    setActiveAnnotationId(ids[0]);
                                  }
                                }}
                                annotatedPdfPages={buildPdfAnnotatedPages(annoByAttachment.get(a.file_id) ?? [])}
                                excelAnnotations={buildExcelAnnotations(annoByAttachment.get(a.file_id) ?? [])}
                                onExcelCellContextMenu={(req, x, y) => {
                                  openContextAdd({ ...req, archive_id: archiveId }, x, y);
                                }}
                                onExcelAnnotationClick={(id) => {
                                  setAnnotationsOpen(true);
                                  setActiveAnnotationId(id);
                                }}
                                docxAnnotations={buildDocxAttachmentAnnoIndex(annoByAttachment.get(a.file_id) ?? [])}
                                docxFocus={docxAttachmentFocus?.file_id === a.file_id ? docxAttachmentFocus : null}
                                onDocxContextMenuCreate={(req, x, y) => {
                                  openContextAdd({ ...req, archive_id: archiveId }, x, y);
                                }}
                                onDocxAnnotationClick={(id) => {
                                  setAnnotationsOpen(true);
                                  setActiveAnnotationId(id);
                                }}
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ opacity: 0.7 }}>加载中...</div>
              )}
            </div>
          </div>
        ) : (
          <div>
            <h3 style={{ marginTop: 0 }}>附件预览</h3>
            {currentAttachment ? (
              <div style={{ border: "1px solid #eee", borderRadius: 12, padding: 12, background: "#fff" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12, opacity: 0.7 }}>{currentAttachment.file_type}</div>
                    <div style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 980 }}>
                      {currentAttachment.display_name}
                    </div>
                  </div>
                  {attachmentPreview ? (
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <button
                        onClick={() =>
                          invoke("open_path", { path: attachmentPreview.path }).catch((e) =>
                            setMsg(String((e as any)?.message ?? e))
                          )
                        }
                      >
                        系统打开
                      </button>
                      {attachmentType === "pdf" ? (
                        <>
                          <button onClick={() => setPdfPage(null)}>文件级批注</button>
                          <button onClick={() => setPdfPage(pdfPage ?? 1)}>页级批注</button>
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
            ) : (
              <div style={{ opacity: 0.7 }}>未选择附件，请返回概览后点击附件打开预览。</div>
            )}

            <div style={{ marginTop: 10 }}>
              {attachmentPreview && attachmentType ? (
                attachmentType === "pdf" ? (
                  <PdfAllPagesViewer
                    filePath={attachmentPreview.path}
                    focusPage={pdfPage ?? undefined}
                    annotatedPages={buildPdfAnnotatedPages(annoByAttachment.get(selectedAttachmentId ?? "") ?? [])}
                    onPageContextMenu={(page, e) => {
                      openContextAdd(
                        { archive_id: archiveId, target_kind: "pdf", target_ref: selectedAttachmentId, locator: { page }, content: "" },
                        e.clientX,
                        e.clientY
                      );
                    }}
                    onPageClick={(page) => {
                      setPdfPage(page);
                      const ids =
                        buildPdfAnnotatedPages(annoByAttachment.get(selectedAttachmentId ?? "") ?? [])?.[page] ?? [];
                      if (ids.length) {
                        setAnnotationsOpen(true);
                        setActiveAnnotationId(ids[0]);
                      }
                    }}
                  />
                ) : attachmentType === "excel" ? (
                  <ExcelViewer
                    fileId={attachmentPreview.file_id}
                    annotations={buildExcelAnnotations(annoByAttachment.get(selectedAttachmentId ?? "") ?? [])}
                    focus={excelFocus?.file_id === selectedAttachmentId ? excelFocus : null}
                    onCellContextMenu={(req, x, y) => {
                      openContextAdd({ ...req, archive_id: archiveId }, x, y);
                    }}
                    onAnnotationClick={(id) => {
                      setAnnotationsOpen(true);
                      setActiveAnnotationId(id);
                    }}
                  />
                ) : attachmentType === "docx_other" ? (
                  <DocxAttachmentPreview
                    fileId={attachmentPreview.file_id}
                    annotations={buildDocxAttachmentAnnoIndex(annoByAttachment.get(selectedAttachmentId ?? "") ?? [])}
                    focus={docxAttachmentFocus?.file_id === selectedAttachmentId ? docxAttachmentFocus : null}
                    onContextMenuCreate={(req, x, y) => openContextAdd({ ...req, archive_id: archiveId }, x, y)}
                    onAnnotationClick={(id) => {
                      setAnnotationsOpen(true);
                      setActiveAnnotationId(id);
                    }}
                  />
                ) : attachmentType === "image" ? (
                  <img
                    src={convertFileSrc(attachmentPreview.path)}
                    style={{ maxWidth: "100%", border: "1px solid #eee", borderRadius: 12, background: "#fff" }}
                  />
                ) : attachmentType === "video" ? (
                  <video
                    controls
                    src={convertFileSrc(attachmentPreview.path)}
                    style={{ width: "100%", border: "1px solid #eee", borderRadius: 12, background: "#fff" }}
                  />
                ) : (
                  <div style={{ fontSize: 12, opacity: 0.7 }}>该类型暂无内置预览，请使用“系统打开”。</div>
                )
              ) : (
                <div style={{ opacity: 0.7 }}>加载预览中...</div>
              )}
            </div>
          </div>
        )}
      </div>

      <AnnotationsSidebar
        open={annotationsOpen}
        onClose={() => {
          setAnnotationsOpen(false);
          setDraftOverride(null);
          setActiveAnnotationId(null);
        }}
        defaultScope="archive"
        archiveId={archiveId}
        currentTarget={
          selectedAttachmentId && attachmentType
            ? { kind: "attachment", file_id: selectedAttachmentId, file_type: attachmentType, page: pdfPage }
            : { kind: "docx", block_id: docxSelection?.block_id }
        }
        draftTarget={draftTarget}
        activeAnnotationId={activeAnnotationId}
        onActiveChange={setActiveAnnotationId}
        onListChange={(items) => setAnnotationsList(items)}
        onJump={(a) => {
          setAnnotationsOpen(true);
          setActiveAnnotationId(a.annotation_id);
          jumpToAnnotation(a);
        }}
      />

      {contextMenu ? (
        <div
          data-context-menu-root
          ref={contextMenuRef}
          style={{
            position: "fixed",
            top: contextMenu.y,
            left: contextMenu.x,
            background: "#fff",
            border: "1px solid #e5e7eb",
            borderRadius: 10,
            boxShadow: "rgba(0,0,0,0.12) 0px 10px 30px",
            padding: 8,
            zIndex: 200,
          }}
          onClick={(e) => {
            e.stopPropagation();
          }}
        >
          <button
            data-context-menu
            onClick={() => beginAnnotate(contextMenu.req)}
            style={{ display: "block", width: "100%", textAlign: "left" }}
          >
            添加批注
          </button>
        </div>
      ) : null}
    </div>
  );
}

function InlineAttachmentPreview({
  fileId,
  fileType,
  onPdfPageContextMenu,
  onPdfPageClick,
  annotatedPdfPages,
  excelAnnotations,
  onExcelCellContextMenu,
  onExcelAnnotationClick,
  docxAnnotations,
  docxFocus,
  onDocxContextMenuCreate,
  onDocxAnnotationClick,
}: {
  fileId: string;
  fileType: string;
  onPdfPageContextMenu?: (page: number, x: number, y: number) => void;
  onPdfPageClick?: (page: number) => void;
  annotatedPdfPages?: Record<number, string[]>;
  excelAnnotations?: { annotation_id: string; sheet_name: string; row: number; col?: number }[];
  onExcelCellContextMenu?: (
    req: { archive_id: string; target_kind: string; target_ref: string; locator: any; content: string },
    x: number,
    y: number
  ) => void;
  onExcelAnnotationClick?: (annotationId: string) => void;
  docxAnnotations?: { byPage?: Record<number, string[]>; byPara?: Record<number, string[]>; byImage?: Record<number, string[]> };
  docxFocus?: { page?: number; para_idx?: number; image_index?: number; ranges?: { start: number; end: number }[] } | null;
  onDocxContextMenuCreate?: (req: any, x: number, y: number) => void;
  onDocxAnnotationClick?: (annotationId: string) => void;
}) {
  const [msg, setMsg] = useState("");
  const [path, setPath] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setMsg("");
    setPath(null);
    // 仅对可预览类型按需解压缓存
    if (fileType === "pdf" || fileType === "excel" || fileType === "image" || fileType === "video" || fileType === "docx_other") {
      invoke<{ file_id: string; path: string }>("get_attachment_preview_path", { fileId })
        .then((r) => {
          if (!cancelled) setPath(r.path);
        })
        .catch((e) => setMsg(String(e?.message ?? e)));
    }
    return () => {
      cancelled = true;
    };
  }, [fileId, fileType]);

  if (fileType === "zip_child" || fileType === "other") {
    return <div style={{ fontSize: 12, opacity: 0.7 }}>该类型仅文件名索引；可使用“放大预览”再选择系统打开。</div>;
  }

  if (fileType === "docx_other") {
    return (
      <div style={{ display: "grid", gap: 8 }}>
        <div style={{ fontSize: 12, opacity: 0.7 }}>附加docx预览（文本/图片）</div>
        <DocxAttachmentPreview
          fileId={fileId}
          annotations={docxAnnotations}
          focus={docxFocus}
          onContextMenuCreate={onDocxContextMenuCreate}
          onAnnotationClick={onDocxAnnotationClick}
        />
      </div>
    );
  }

  if (!path) {
    return msg ? <div style={{ whiteSpace: "pre-wrap", color: "#b00" }}>{msg}</div> : <div style={{ fontSize: 12, opacity: 0.7 }}>加载预览中...</div>;
  }

  if (fileType === "image") {
    return (
      <img
        src={convertFileSrc(path)}
        style={{ width: "100%", border: "1px solid #eee", borderRadius: 10, background: "#fff", maxHeight: 260, objectFit: "contain" }}
      />
    );
  }
  if (fileType === "video") {
    return (
      <video
        controls
        preload="none"
        src={convertFileSrc(path)}
        style={{ width: "100%", border: "1px solid #eee", borderRadius: 10, background: "#fff" }}
      />
    );
  }
  if (fileType === "pdf") {
    return (
      <div style={{ display: "grid", gap: 8 }}>
        <div style={{ fontSize: 12, opacity: 0.7 }}>PDF 预览（默认平铺全部页）</div>
        <PdfAllPagesViewer
          filePath={path}
          variant="thumbs"
          anchorPrefix={pdfAnchorPrefix(fileId)}
          annotatedPages={annotatedPdfPages}
          onPageContextMenu={(p, e) => onPdfPageContextMenu?.(p, e.clientX, e.clientY)}
          onPageClick={(p) => onPdfPageClick?.(p)}
        />
      </div>
    );
  }
  if (fileType === "excel") {
    return (
      <div style={{ display: "grid", gap: 8 }}>
        <div style={{ fontSize: 12, opacity: 0.7 }}>Excel 预览（可滚动浏览全表）</div>
        <ExcelViewer
          fileId={fileId}
          annotations={excelAnnotations}
          onCellContextMenu={onExcelCellContextMenu}
          onAnnotationClick={onExcelAnnotationClick}
        />
      </div>
    );
  }
  return <div style={{ fontSize: 12, opacity: 0.7 }}>暂无内置预览。</div>;
}

function buildPdfAnnotatedPages(items: any[]): Record<number, string[]> {
  const out: Record<number, string[]> = {};
  for (const a of items ?? []) {
    if (a.target_kind !== "pdf") continue;
    const p = a.locator?.page;
    if (typeof p !== "number") continue;
    out[p] = out[p] ?? [];
    out[p].push(a.annotation_id);
  }
  return out;
}

function buildExcelAnnotations(items: any[]): { annotation_id: string; sheet_name: string; row: number; col?: number }[] {
  const out: { annotation_id: string; sheet_name: string; row: number; col?: number }[] = [];
  for (const a of items ?? []) {
    if (a.target_kind !== "excel") continue;
    const sheet = a.locator?.sheet_name;
    const row = a.locator?.row;
    const col = a.locator?.col;
    if (!sheet || typeof row !== "number") continue;
    out.push({ annotation_id: a.annotation_id, sheet_name: sheet, row, col: typeof col === "number" ? col : undefined });
  }
  return out;
}

function buildDocxAttachmentAnnoIndex(items: any[]): {
  byPage: Record<number, string[]>;
  byPara: Record<number, string[]>;
  byImage: Record<number, string[]>;
} {
  const byPage: Record<number, string[]> = {};
  const byPara: Record<number, string[]> = {};
  const byImage: Record<number, string[]> = {};
  for (const a of items ?? []) {
    if (a.target_kind !== "docx") continue;
    const page = a.locator?.page;
    const paraIdx = a.locator?.para_idx;
    const imgIdx = a.locator?.image_index;
    if (typeof page === "number") {
      byPage[page] = byPage[page] ?? [];
      byPage[page].push(a.annotation_id);
    }
    if (typeof paraIdx === "number") {
      byPara[paraIdx] = byPara[paraIdx] ?? [];
      byPara[paraIdx].push(a.annotation_id);
    }
    if (typeof imgIdx === "number") {
      byImage[imgIdx] = byImage[imgIdx] ?? [];
      byImage[imgIdx].push(a.annotation_id);
    }
  }
  return { byPage, byPara, byImage };
}

function pdfAnchorPrefix(fileId: string) {
  // 用于 DOM id，避免特殊字符
  return `pdf-${String(fileId).replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function groupAttachments(
  attachments: {
    file_id: string;
    display_name: string;
    file_type: string;
    source_depth: number;
    container_virtual_path?: string | null;
  }[]
) {
  const main: typeof attachments = [];
  const byChild: Record<string, typeof attachments> = {};

  for (const a of attachments) {
    if (a.source_depth === 0) {
      main.push(a);
      continue;
    }
    const child =
      extractChildZipNameFromContainerPath(a.container_virtual_path) ??
      extractChildZipName(a.display_name) ??
      "子ZIP";
    byChild[child] = byChild[child] ?? [];
    byChild[child].push(a);
  }

  const groups: { key: string; title: string; items: typeof attachments }[] = [];
  if (main.length) groups.push({ key: "main", title: "主ZIP", items: main });
  for (const k of Object.keys(byChild).sort()) {
    groups.push({ key: `child:${k}`, title: `子ZIP：${k}`, items: byChild[k] });
  }
  return groups;
}

function extractChildZipName(displayName: string) {
  // display_name 形如 "[子包.zip]/xxx.ext"
  const m = /^\[([^\]]+)\]\//.exec(displayName);
  return m?.[1] ?? null;
}

function extractChildZipNameFromContainerPath(containerVirtualPath?: string | null) {
  if (!containerVirtualPath) return null;
  // container_virtual_path 是子ZIP在主ZIP内的路径，例如 "子包.zip" 或 "folder/子包.zip"
  const parts = containerVirtualPath.split("/").filter(Boolean);
  const last = parts[parts.length - 1];
  return last || null;
}
