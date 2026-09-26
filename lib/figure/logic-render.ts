/**
 * SVG for logic-puzzle diagrams (grid, Venn, ordering, tree). Pure string
 * building like render.ts, so it runs in the browser and step highlights
 * re-render instantly. Highlight ids: item names (grid rows/columns,
 * ordering items, tree options) and Venn region keys ("A", "AB", "none" …).
 */
import { vennAskLabel, type LogicSolved, type LogicSpec } from "./logic";

const C = {
  text: "#e2e8f0",
  muted: "#94a3b8",
  line: "#475569",
  grid: "#334155",
  hi: "#f59e0b",
  ok: "#22c55e",
  no: "#64748b",
  sets: ["#60a5fa", "#f472b6", "#34d399"],
};
const FONT = `font-family="system-ui, 'PingFang SC', 'Noto Sans CJK SC', 'Microsoft YaHei', sans-serif"`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const svg = (w: number, h: number, body: string[]) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" ${FONT}>${body.join("")}</svg>`;
const text = (x: number, y: number, s: string, opts: { size?: number; fill?: string; anchor?: string; weight?: string } = {}) =>
  `<text x="${x}" y="${y}" font-size="${opts.size ?? 13}" fill="${opts.fill ?? C.text}" text-anchor="${opts.anchor ?? "middle"}"${opts.weight ? ` font-weight="${opts.weight}"` : ""}>${esc(s)}</text>`;
/** Rough rendered width of a label (CJK ≈ 1em, Latin ≈ 0.6em). */
const textWidth = (s: string, size: number) => [...s].reduce((w, ch) => w + (ch.codePointAt(0)! >= 0x2000 ? size : size * 0.6), 0);

// Language of the diagram's own labels; set per call (rendering is synchronous).
let EN = false;
const tr = (zh: string, en: string) => (EN ? en : zh);

export function renderLogicSvg(spec: LogicSpec, solved: LogicSolved, highlight: string[] = [], locale: "zh-CN" | "en-US" = "zh-CN"): string {
  EN = locale === "en-US";
  const hi = new Set(highlight);
  if (spec.type === "grid" && solved.type === "grid") return renderGrid(spec, solved, hi);
  if (spec.type === "venn" && solved.type === "venn") return renderVenn(spec, solved, hi);
  if (spec.type === "ordering" && solved.type === "ordering") return renderOrdering(spec, solved, hi);
  if (spec.type === "tree" && solved.type === "tree") return renderTree(spec, solved, hi);
  return svg(200, 40, [text(100, 24, tr("无法绘制", "Cannot draw"), { fill: C.muted })]);
}

// ── Grid ───────────────────────────────────────────────────────────────

function renderGrid(g: Extract<LogicSpec, { type: "grid" }>, s: Extract<LogicSolved, { type: "grid" }>, hi: Set<string>): string {
  const rows = g.categories[0].items;
  const cats = g.categories.slice(1);
  const colW = Math.max(44, ...cats.flatMap((c) => c.items.map((it) => textWidth(it, 13) + 14)));
  const rowH = 34;
  const headW = Math.max(64, ...rows.map((r) => textWidth(r, 14) + 20), textWidth(g.categories[0].name, 12) + 16);
  const top = 50;
  const gap = 10;
  const width = headW + cats.reduce((w, c) => w + c.items.length * colW + gap, 0) + 4;
  const height = top + rows.length * rowH + (s.solutions === 1 ? 34 : 30);
  const out: string[] = [];
  out.push(text(headW / 2, top - 8, g.categories[0].name, { size: 12, fill: C.muted }));
  rows.forEach((r, ri) => {
    const y = top + ri * rowH;
    const on = hi.has(r);
    if (on) out.push(`<rect x="0" y="${y}" width="${headW - 4}" height="${rowH}" rx="4" fill="${C.hi}" fill-opacity="0.18"/>`);
    out.push(text(headW / 2, y + rowH / 2 + 5, r, { size: 14, fill: on ? C.hi : C.text, weight: "600" }));
  });
  let x0 = headW;
  cats.forEach((cat, ci) => {
    const w = cat.items.length * colW;
    out.push(text(x0 + w / 2, 16, cat.name, { size: 12, fill: C.muted }));
    cat.items.forEach((it, ii) => {
      const x = x0 + ii * colW;
      const on = hi.has(it);
      if (on) out.push(`<rect x="${x + 1}" y="22" width="${colW - 2}" height="${top - 24}" rx="4" fill="${C.hi}" fill-opacity="0.18"/>`);
      out.push(text(x + colW / 2, top - 8, it, { size: 13, fill: on ? C.hi : C.text }));
      rows.forEach((r, ri) => {
        const y = top + ri * rowH;
        const v = s.cells[ri]?.[ci]?.[ii] ?? 0;
        const cellHi = hi.has(r) || on;
        out.push(`<rect x="${x}" y="${y}" width="${colW}" height="${rowH}" fill="${cellHi ? C.hi : "none"}" fill-opacity="${cellHi ? 0.07 : 0}" stroke="${C.grid}" stroke-width="1"/>`);
        const cx = x + colW / 2;
        const cy = y + rowH / 2;
        if (v === 1) out.push(`<circle cx="${cx}" cy="${cy}" r="10" fill="${C.ok}" fill-opacity="0.18"/><path d="M${cx - 6},${cy} l4,4.5 l8,-9" stroke="${C.ok}" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`);
        else if (v === -1) out.push(`<path d="M${cx - 5},${cy - 5} l10,10 M${cx + 5},${cy - 5} l-10,10" stroke="${C.no}" stroke-width="1.6" stroke-linecap="round"/>`);
      });
    });
    out.push(`<rect x="${x0}" y="${top}" width="${w}" height="${rows.length * rowH}" fill="none" stroke="${C.line}" stroke-width="1.4"/>`);
    x0 += w + gap;
  });
  const footY = top + rows.length * rowH + 22;
  // Footer: the conclusion when unique (wrapped to the table width, at least 360px), else a legend.
  const lines: string[] = [];
  let footSize = 12;
  let footFill = C.muted;
  if (s.solutions === 1) {
    footSize = 13;
    footFill = C.ok;
    const parts = rows.map((r, ri) => [r, ...cats.map((cat, ci) => cat.items[s.cells[ri][ci].indexOf(1)] ?? "?")].join("—"));
    const maxW = Math.max(width, 360);
    const head = tr("结论：", "Answer: ");
    let line = head;
    parts.forEach((p, i) => {
      const piece = p + (i < parts.length - 1 ? tr("，", "; ") : "");
      if (line !== head && line !== "" && textWidth(line + piece, 13) > maxW) {
        lines.push(line);
        line = "";
      }
      line += piece;
    });
    lines.push(line);
  } else {
    lines.push(s.solutions === 0 ? tr("条件矛盾：无解", "Conditions contradict: no solution") : tr(`✓ 为已确定，空白为仍有多种可能（共 ${s.solutions} 种解）`, `✓ = determined; blank = still open (${s.solutions} solutions)`));
  }
  lines.forEach((l, i) => out.push(text(4, footY + i * 20, l, { size: footSize, fill: footFill, anchor: "start" })));
  const W = Math.max(width, ...lines.map((l) => textWidth(l, footSize) + 10));
  return svg(W, height + (lines.length - 1) * 20, out);
}

// ── Venn ───────────────────────────────────────────────────────────────

function renderVenn(v: Extract<LogicSpec, { type: "venn" }>, s: Extract<LogicSolved, { type: "venn" }>, hi: Set<string>): string {
  const three = v.sets.length === 3;
  const W = 480;
  const H = three ? 360 : 290;
  const r = three ? 92 : 100;
  const centers = three
    ? [
        { x: 190, y: 138 },
        { x: 290, y: 138 },
        { x: 240, y: 222 },
      ]
    : [
        { x: 190, y: 150 },
        { x: 290, y: 150 },
      ];
  const pos: Record<string, { x: number; y: number }> = three
    ? { A: { x: 150, y: 115 }, B: { x: 330, y: 115 }, C: { x: 240, y: 280 }, AB: { x: 240, y: 102 }, AC: { x: 185, y: 200 }, BC: { x: 295, y: 200 }, ABC: { x: 240, y: 168 }, none: { x: 440, y: H - 22 } }
    : { A: { x: 138, y: 155 }, B: { x: 342, y: 155 }, AB: { x: 240, y: 155 }, none: { x: 440, y: H - 22 } };
  const out: string[] = [];
  const showUniverse = v.universe !== undefined || v.neither !== undefined || s.regions.none !== null;
  if (showUniverse) {
    out.push(`<rect x="8" y="8" width="${W - 16}" height="${H - 16}" rx="10" fill="none" stroke="${C.line}" stroke-width="1.4"/>`);
    out.push(text(20, 30, `${v.universe_label ?? tr("全体", "All")}${v.universe !== undefined ? tr(`（${v.universe}）`, ` (${v.universe})`) : ""}`, { size: 12, fill: C.muted, anchor: "start" }));
  }
  v.sets.forEach((set, i) => {
    const c = centers[i];
    out.push(`<circle cx="${c.x}" cy="${c.y}" r="${r}" fill="${C.sets[i]}" fill-opacity="0.12" stroke="${C.sets[i]}" stroke-width="2"/>`);
    const label = `${set.label}${set.total !== undefined ? `（${set.total}）` : ""}`;
    const lx = i === 0 ? c.x - r * 0.55 : i === 1 ? c.x + r * 0.55 : c.x;
    const ly = i === 2 ? c.y + r + 18 : c.y - r - 8;
    out.push(text(lx, ly, label, { size: 13, fill: C.sets[i], weight: "600" }));
  });
  const regionKeys = three ? ["A", "B", "C", "AB", "AC", "BC", "ABC", "none"] : ["A", "B", "AB", "none"];
  for (const k of regionKeys) {
    if (k === "none" && !showUniverse) continue;
    const val = s.regions[k];
    const p = pos[k];
    const on = hi.has(k);
    const label = val === null || val === undefined ? "?" : String(Math.round(val * 1000) / 1000);
    if (on) out.push(`<circle cx="${p.x}" cy="${p.y - 5}" r="17" fill="${C.hi}" fill-opacity="0.25" stroke="${C.hi}" stroke-width="1.6"/>`);
    out.push(text(p.x, p.y, label, { size: 17, fill: on ? C.hi : label === "?" ? C.muted : C.text, weight: "700" }));
    if (k === "none") out.push(text(p.x - 34, p.y + 5, tr("都不", "None"), { size: 11, fill: C.muted, anchor: "end" }));
  }
  if (v.ask && s.asked !== undefined) {
    out.push(text(20, H - 22, tr(`所求：${vennAskLabel(v.ask, v.sets)}人数 = ${s.asked === null ? "?" : s.asked}`, `Asked: ${vennAskLabel(v.ask, v.sets, true)} = ${s.asked === null ? "?" : s.asked}`), { size: 13, fill: s.asked === null ? C.muted : C.ok, anchor: "start" }));
  }
  return svg(W, H, out);
}

// ── Ordering ───────────────────────────────────────────────────────────

function renderOrdering(o: Extract<LogicSpec, { type: "ordering" }>, s: Extract<LogicSolved, { type: "ordering" }>, hi: Set<string>): string {
  const n = o.items.length;
  const distinct = s.distinct ?? s.solutions;
  const counting = o.count !== undefined;
  // Unique (up to symmetry) or a counting question: draw one full arrangement; otherwise only the fixed seats.
  const whole = s.sample && (distinct === 1 || counting);
  const label = (seat: number) => (whole ? s.sample![seat] : s.fixed[seat]);
  const unique = distinct === 1 && !counting;
  const out: string[] = [];
  const note =
    s.solutions === 0
      ? tr("条件矛盾：无法排列", "Conditions contradict: no arrangement")
      : counting
        ? tr(`共 ${s.solutions} 种排法（图为其中一种）`, `${s.solutions} arrangements (one shown)`)
        : unique
          ? tr("唯一排列", "Unique arrangement")
          : tr(`共 ${distinct} 种排列，「?」处尚未确定`, `${distinct} arrangements; \"?\" is not yet determined`);
  if (o.layout === "row") {
    const boxW = Math.max(56, ...o.items.map((it) => textWidth(it, 14) + 16));
    const gap = 10;
    const x0 = 40;
    const W = x0 * 2 + n * boxW + (n - 1) * gap;
    const H = 130;
    for (let i = 0; i < n; i++) {
      const x = x0 + i * (boxW + gap);
      const who = label(i);
      const on = who ? hi.has(who) : false;
      out.push(`<rect x="${x}" y="30" width="${boxW}" height="46" rx="8" fill="${on ? C.hi : C.sets[0]}" fill-opacity="${on ? 0.22 : who ? 0.12 : 0.03}" stroke="${on ? C.hi : who ? C.sets[0] : C.line}" stroke-width="${on ? 2.2 : 1.4}"${who ? "" : ' stroke-dasharray="5 4"'}/>`);
      out.push(text(x + boxW / 2, 58, who ?? "?", { size: 15, fill: on ? C.hi : who ? C.text : C.muted, weight: "600" }));
      out.push(text(x + boxW / 2, 94, tr(`第${i + 1}个`, `#${i + 1}`), { size: 11, fill: C.muted }));
    }
    const [l, r] = o.ends ?? [tr("左", "Left"), tr("右", "Right")];
    out.push(text(18, 58, l, { size: 12, fill: C.muted }));
    out.push(text(W - 18, 58, r, { size: 12, fill: C.muted }));
    out.push(text(W / 2, 120, note, { size: 12, fill: unique ? C.ok : C.muted }));
    return svg(W, H, out);
  }
  // circle
  const W = 380;
  const H = 360;
  const cx = W / 2;
  const cy = 170;
  const R = 120;
  out.push(`<circle cx="${cx}" cy="${cy}" r="${R - 42}" fill="${C.grid}" fill-opacity="0.35" stroke="${C.line}" stroke-width="1.4"/>`);
  out.push(text(cx, cy + 4, tr("圆桌", "Table"), { size: 12, fill: C.muted }));
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
    const x = cx + R * Math.cos(a);
    const y = cy + R * Math.sin(a);
    const who = label(i);
    const on = who ? hi.has(who) : false;
    out.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="26" fill="${on ? C.hi : C.sets[0]}" fill-opacity="${on ? 0.22 : who ? 0.14 : 0.03}" stroke="${on ? C.hi : who ? C.sets[0] : C.line}" stroke-width="${on ? 2.2 : 1.4}"${who ? "" : ' stroke-dasharray="5 4"'}/>`);
    out.push(text(+x.toFixed(1), +(y + 5).toFixed(1), who ?? "?", { size: 14, fill: on ? C.hi : who ? C.text : C.muted, weight: "600" }));
  }
  out.push(text(cx, H - 18, tr(`${note}（顺时针；旋转${s.mirror ? "、翻转" : ""}视为同一种）`, `${note} (clockwise; rotations${s.mirror ? " and reflections" : ""} count once)`), { size: 12, fill: unique ? C.ok : C.muted }));
  return svg(W, H, out);
}

// ── Tree ───────────────────────────────────────────────────────────────

function renderTree(t: Extract<LogicSpec, { type: "tree" }>, s: Extract<LogicSolved, { type: "tree" }>, hi: Set<string>): string {
  const levels = t.levels.length;
  const leafH = 22;
  const colW = Math.max(90, ...t.levels.flatMap((l) => l.options.map((o) => textWidth(o, 13) + 36)));
  const top = 40;
  const leaves = s.paths.length;
  const H = top + Math.max(leaves, 1) * leafH + 44;
  const W = 60 + levels * colW + 150;
  const out: string[] = [];
  t.levels.forEach((l, i) => out.push(text(60 + i * colW + colW / 2, 20, l.label, { size: 12, fill: C.muted })));
  // Node y = mean of its leaves' y; nodes keyed by path prefix.
  const nodeY = new Map<string, number[]>();
  s.paths.forEach((p, li) => {
    const y = top + li * leafH + leafH / 2;
    for (let d = 1; d <= p.length; d++) {
      const key = p.slice(0, d).join("\u0001");
      if (!nodeY.has(key)) nodeY.set(key, []);
      nodeY.get(key)!.push(y);
    }
  });
  const yOf = (key: string) => {
    const ys = nodeY.get(key)!;
    return (Math.min(...ys) + Math.max(...ys)) / 2;
  };
  const rootY = top + (Math.max(leaves, 1) * leafH) / 2;
  out.push(`<circle cx="30" cy="${rootY}" r="5" fill="${C.muted}"/>`);
  const drawn = new Set<string>();
  s.paths.forEach((p, li) => {
    for (let d = 1; d <= p.length; d++) {
      const key = p.slice(0, d).join("\u0001");
      if (drawn.has(key)) continue;
      drawn.add(key);
      const x = 60 + (d - 1) * colW + colW / 2;
      const y = yOf(key);
      const px = d === 1 ? 30 : 60 + (d - 2) * colW + colW / 2 + textWidth(p[d - 2], 13) / 2 + 6;
      const py = d === 1 ? rootY : yOf(p.slice(0, d - 1).join("\u0001"));
      const on = hi.has(p[d - 1]);
      out.push(`<line x1="${px}" y1="${py}" x2="${x - textWidth(p[d - 1], 13) / 2 - 6}" y2="${y}" stroke="${on ? C.hi : C.line}" stroke-width="${on ? 2 : 1.2}"/>`);
      out.push(text(x, y + 4.5, p[d - 1], { size: 13, fill: on ? C.hi : C.text }));
    }
    const lastX = 60 + (p.length - 1) * colW + colW / 2 + textWidth(p[p.length - 1], 13) / 2 + 14;
    out.push(text(lastX, top + li * leafH + leafH / 2 + 4.5, `${li + 1}. ${p.join("")}`, { size: 11, fill: C.muted, anchor: "start" }));
  });
  out.push(text(30, H - 16, s.truncated ? tr(`共 ${s.count} 种（图中画出前 ${leaves} 种）`, `${s.count} in total (first ${leaves} shown)`) : tr(`共 ${s.count} 种`, `${s.count} in total`), { size: 13, fill: C.ok, anchor: "start", weight: "600" }));
  return svg(W, H, out);
}
