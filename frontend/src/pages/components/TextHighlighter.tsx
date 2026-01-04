export default function TextHighlighter({
  text,
  ranges,
}: {
  text: string;
  ranges: { start: number; end: number }[];
}) {
  if (!ranges?.length) return <span style={{ whiteSpace: "pre-wrap" }}>{text}</span>;

  const merged = mergeRanges(ranges);
  const parts: { t: string; hi: boolean }[] = [];
  let pos = 0;
  for (const r of merged) {
    const start = clamp(r.start, 0, text.length);
    const end = clamp(r.end, 0, text.length);
    if (start > pos) parts.push({ t: text.slice(pos, start), hi: false });
    if (end > start) parts.push({ t: text.slice(start, end), hi: true });
    pos = end;
  }
  if (pos < text.length) parts.push({ t: text.slice(pos), hi: false });

  return (
    <span style={{ whiteSpace: "pre-wrap" }}>
      {parts.map((p, i) =>
        p.hi ? (
          <mark key={i} style={{ background: "#ffef99" }}>
            {p.t}
          </mark>
        ) : (
          <span key={i}>{p.t}</span>
        )
      )}
    </span>
  );
}

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function mergeRanges(ranges: { start: number; end: number }[]) {
  const sorted = [...ranges]
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start)
    .sort((a, b) => (a.start - b.start) || (a.end - b.end));
  if (!sorted.length) return [];
  const out = [sorted[0]];
  for (const r of sorted.slice(1)) {
    const last = out[out.length - 1];
    if (r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

