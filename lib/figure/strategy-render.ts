/**
 * SVG for solution-strategy figures (lib/figure/strategy.ts). Pure and deterministic; runs in the
 * browser, so moving through the solution steps or the slider re-renders instantly.
 *
 * `step` (1-based, or null for the whole figure) hides elements whose `from_step` is later and keeps
 * unknown values as "?" until their `reveal_step`; `highlight` ids are drawn in the highlight colour.
 */
import { compileExprVars } from "./expr";
import { fmtNum, type StrategySolved, type StrategySpec } from "./strategy";

export interface StrategyRenderOptions {
  highlight?: string[];
  /** Current solution step (null / undefined = the whole figure, every value shown). */
  step?: number | null;
  locale?: "zh-CN" | "en-US";
  /** Slider value (graph_explore). */
  param?: number;
}

const C = {
  stroke: "#cbd5e1",
  muted: "#94a3b8",
  text: "#f1f5f9",
  hi: "#f59e0b",
  hiFill: "rgba(245,158,11,0.22)",
  fill: "rgba(96,165,250,0.20)",
  shade: "rgba(96,165,250,0.45)",
  ok: "#34d399",
  okFill: "rgba(52,211,153,0.16)",
  grid: "#334155",
  fns: ["#60a5fa", "#f472b6", "#34d399", "#fbbf24"],
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const r1 = (v: number) => Math.round(v * 10) / 10;
const text = (x: number, y: number, s: string, o: { size?: number; anchor?: "start" | "middle" | "end"; color?: string; bold?: boolean } = {}) =>
  `<text x="${r1(x)}" y="${r1(y)}" font-size="${o.size ?? 13}" text-anchor="${o.anchor ?? "middle"}" fill="${o.color ?? C.text}"${o.bold ? ' font-weight="600"' : ""} font-family="system-ui, -apple-system, 'PingFang SC', 'Noto Sans SC', sans-serif">${esc(s)}</text>`;
const svgWrap = (w: number, h: number, body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${r1(w)} ${r1(h)}" width="${r1(w)}" height="${r1(h)}">${body}</svg>`;

/** Horizontal curly brace from x0 to x1 at y, opening downward (up = false: opening upward). */
function brace(x0: number, x1: number, y: number, up: boolean, color: string): string {
  const d = up ? -1 : 1;
  const h = 7 * d;
  const m = (x0 + x1) / 2;
  return `<path d="M${r1(x0)},${r1(y + h)} Q${r1(x0)},${r1(y)} ${r1(x0 + 8)},${r1(y)} L${r1(m - 6)},${r1(y)} Q${r1(m)},${r1(y)} ${r1(m)},${r1(y - h)} Q${r1(m)},${r1(y)} ${r1(m + 6)},${r1(y)} L${r1(x1 - 8)},${r1(y)} Q${r1(x1)},${r1(y)} ${r1(x1)},${r1(y + h)}" fill="none" stroke="${color}" stroke-width="1.4"/>`;
}

function niceStep(range: number, target = 10): number {
  const raw = range / target;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

export function renderStrategySvg(spec: StrategySpec, solved: StrategySolved | undefined, opts: StrategyRenderOptions = {}): string {
  const hi = new Set(opts.highlight ?? []);
  const step = opts.step ?? null;
  const shown = (from?: number) => step === null || !from || from <= step;
  const revealed = (unknown?: boolean, at?: number) => !unknown || step === null || (at !== undefined && at <= step);
  const en = opts.locale === "en-US";
  switch (spec.type) {
    case "bar_model":
      return barModel(spec, solved?.type === "bar_model" ? solved : undefined, hi, shown, revealed, en);
    case "number_line":
      return numberLine(spec, hi, shown, revealed);
    case "prob_tree":
      return probTree(spec, solved?.type === "prob_tree" ? solved : undefined, hi, shown, en);
    case "enum_table":
      return enumTable(spec, solved?.type === "enum_table" ? solved : undefined, hi, shown, en);
    case "graph_explore":
      return graph(spec, hi, shown, opts.param, en);
  }
}

// ── Bar model ──────────────────────────────────────────────────────────

function barModel(
  b: Extract<StrategySpec, { type: "bar_model" }>,
  s: Extract<StrategySolved, { type: "bar_model" }> | undefined,
  hi: Set<string>,
  shown: (f?: number) => boolean,
  revealed: (u?: boolean, at?: number) => boolean,
  en: boolean,
): string {
  const unit = s?.unit ?? null;
  const withUnit = (v: number) => `${fmtNum(v)}${b.unit ? ` ${b.unit}` : ""}`;
  const len = (p: (typeof b.bars)[number]["parts"][number]) => {
    const v = s?.parts[p.id];
    if (v !== null && v !== undefined && v > 0) return v;
    if (p.units !== undefined) return p.units * (unit ?? 1);
    return unit ?? 1;
  };
  const barLen = (bar: (typeof b.bars)[number]) => bar.parts.reduce((t, p) => t + len(p), 0);
  const maxLen = Math.max(...b.bars.map(barLen), 1e-9);
  const LW = b.bars.some((x) => x.label) ? Math.min(120, 14 + Math.max(...b.bars.map((x) => (x.label ?? "").length)) * 13) : 10;
  const BW = 440;
  const scale = BW / maxLen;
  const rowH = 34;
  const gap = 58;
  const top = 34;
  const out: string[] = [];
  const barX = new Map<string, { x0: number; x1: number; y: number }>();
  b.bars.forEach((bar, i) => {
    const y = top + i * (rowH + gap);
    if (!shown(bar.from_step)) return;
    let x = LW;
    if (bar.label) out.push(text(LW - 8, y + rowH / 2 + 5, bar.label, { anchor: "end", color: hi.has(bar.id) ? C.hi : C.text }));
    // The whole bar's outline, so parts added in later steps fill a bar that is already there.
    out.push(`<rect x="${LW}" y="${y}" width="${r1(barLen(bar) * scale)}" height="${rowH}" fill="none" stroke="${C.muted}" stroke-width="1" stroke-dasharray="4 3"/>`);
    for (const p of bar.parts) {
      const w = len(p) * scale;
      if (shown(p.from_step)) {
        const on = hi.has(p.id) || hi.has(bar.id);
        out.push(`<rect x="${r1(x)}" y="${y}" width="${r1(w)}" height="${rowH}" fill="${on ? C.hiFill : p.shade ? C.shade : C.fill}" stroke="${on ? C.hi : C.stroke}" stroke-width="${on ? 2.2 : 1.4}"/>`);
        // Equal units inside the part.
        if (p.units && Number.isInteger(p.units) && p.units > 1 && p.units <= 40) {
          for (let k = 1; k < p.units; k++) {
            const xx = x + (w * k) / p.units;
            out.push(`<line x1="${r1(xx)}" y1="${y}" x2="${r1(xx)}" y2="${y + rowH}" stroke="${on ? C.hi : C.muted}" stroke-width="0.8" stroke-dasharray="3 2"/>`);
          }
        }
        const v = s?.parts[p.id];
        const valueText = !revealed(p.unknown, p.reveal_step) ? "?" : v !== null && v !== undefined ? withUnit(v) : p.units !== undefined ? (en ? `${fmtNum(p.units)} units` : `${fmtNum(p.units)} 份`) : "?";
        const name = p.label ?? "";
        if (w >= 64) {
          if (name) out.push(text(x + w / 2, y + 14, name, { size: 11, color: on ? C.hi : C.muted }));
          out.push(text(x + w / 2, y + (name ? 28 : 22), valueText, { size: 13, bold: true, color: on ? C.hi : C.text }));
        } else {
          out.push(text(x + w / 2, y + rowH / 2 + 5, valueText, { size: 12, bold: true, color: on ? C.hi : C.text }));
          if (name) out.push(text(x + w / 2, y + rowH + 14, name, { size: 10, color: on ? C.hi : C.muted }));
        }
      }
      x += w;
    }
    barX.set(bar.id, { x0: LW, x1: x, y });
    // Total above the bar.
    const total = s?.bars[bar.id];
    const askedHere = b.ask === bar.id;
    if (bar.total !== undefined || bar.total_label || askedHere) {
      const on = hi.has(bar.id);
      const t = askedHere && !revealed(true, undefined) ? "?" : bar.total_label ?? (total !== null && total !== undefined ? withUnit(total) : "?");
      out.push(brace(LW, x, y - 6, true, on ? C.hi : C.muted));
      out.push(text((LW + x) / 2, y - 18, t, { size: 12, color: on ? C.hi : C.text }));
    }
  });
  // Relations.
  let extraRight = 0;
  for (const r of b.relations ?? []) {
    if (!shown(r.from_step)) continue;
    const on = hi.has(r.id);
    const color = on ? C.hi : C.muted;
    const v = s?.relations[r.id];
    const t = !revealed(r.unknown, r.reveal_step) ? "?" : r.label ?? (r.value !== undefined ? withUnit(r.value) : v !== null && v !== undefined ? withUnit(v) : "?");
    const pos = r.bars.map((id) => barX.get(id)).filter(Boolean) as Array<{ x0: number; x1: number; y: number }>;
    if (pos.length < 2) continue;
    if (r.type === "sum") {
      const xr = Math.max(...pos.map((p) => p.x1)) + 14;
      const y0 = Math.min(...pos.map((p) => p.y));
      const y1 = Math.max(...pos.map((p) => p.y)) + rowH;
      out.push(`<path d="M${r1(xr)},${y0} Q${r1(xr + 8)},${y0} ${r1(xr + 8)},${y0 + 8} L${r1(xr + 8)},${r1((y0 + y1) / 2 - 6)} Q${r1(xr + 8)},${r1((y0 + y1) / 2)} ${r1(xr + 15)},${r1((y0 + y1) / 2)} Q${r1(xr + 8)},${r1((y0 + y1) / 2)} ${r1(xr + 8)},${r1((y0 + y1) / 2 + 6)} L${r1(xr + 8)},${y1 - 8} Q${r1(xr + 8)},${y1} ${r1(xr)},${y1}" fill="none" stroke="${color}" stroke-width="1.4"/>`);
      out.push(text(xr + 20, (y0 + y1) / 2 + 5, t, { anchor: "start", size: 12, color: on ? C.hi : C.text }));
      extraRight = Math.max(extraRight, 30 + t.length * 8);
    } else {
      const [a, c] = pos;
      const longer = a.x1 >= c.x1 ? a : c;
      const shorter = longer === a ? c : a;
      out.push(`<line x1="${r1(shorter.x1)}" y1="${Math.min(a.y, c.y)}" x2="${r1(shorter.x1)}" y2="${Math.max(a.y, c.y) + rowH}" stroke="${color}" stroke-dasharray="4 3" stroke-width="1.2"/>`);
      const yb = longer.y + rowH + 6;
      out.push(brace(shorter.x1, longer.x1, yb, false, color));
      out.push(text((shorter.x1 + longer.x1) / 2, yb + 22, t, { size: 12, color: on ? C.hi : C.text }));
    }
  }
  const H = top + b.bars.length * (rowH + gap) - gap + 40;
  return svgWrap(LW + BW + 20 + extraRight, H, out.join(""));
}

// ── Number line ───────────────────────────────────────────────────────

function numberLine(n: Extract<StrategySpec, { type: "number_line" }>, hi: Set<string>, shown: (f?: number) => boolean, revealed: (u?: boolean, at?: number) => boolean): string {
  const W = 520;
  const pad = 28;
  const X = (v: number) => pad + ((v - n.min) / (n.max - n.min)) * (W - 2 * pad);
  const jumpsH = n.jumps.length ? 70 : 30;
  const y = jumpsH + 10;
  const out: string[] = [];
  out.push(`<line x1="${pad - 12}" y1="${y}" x2="${W - pad + 14}" y2="${y}" stroke="${C.stroke}" stroke-width="1.6"/>`);
  out.push(`<path d="M${W - pad + 14},${y} l-8,-4 l0,8 z" fill="${C.stroke}"/>`);
  const tick = n.tick ?? niceStep(n.max - n.min);
  const first = Math.ceil(n.min / tick - 1e-9) * tick;
  const count = Math.floor((n.max - first) / tick + 1e-9);
  const every = count > 20 ? Math.ceil(count / 10) : 1;
  for (let i = 0; i <= count && i < 200; i++) {
    const v = first + i * tick;
    out.push(`<line x1="${r1(X(v))}" y1="${y - 5}" x2="${r1(X(v))}" y2="${y + 5}" stroke="${C.stroke}" stroke-width="1"/>`);
    if (i % every === 0) out.push(text(X(v), y + 20, fmtNum(v), { size: 11, color: C.muted }));
  }
  if (n.unit) out.push(text(W - pad + 14, y + 20, n.unit, { size: 11, color: C.muted, anchor: "end" }));
  // Jumps: arcs above.
  n.jumps.forEach((j, i) => {
    if (!shown(j.from_step)) return;
    const on = hi.has(j.id);
    const x0 = X(j.from);
    const x1 = X(j.to);
    const h = 22 + (i % 2) * 14;
    out.push(`<path d="M${r1(x0)},${y - 3} Q${r1((x0 + x1) / 2)},${y - 2 * h} ${r1(x1)},${y - 3}" fill="none" stroke="${on ? C.hi : C.fns[0]}" stroke-width="${on ? 2.4 : 1.6}"/>`);
    out.push(`<path d="M${r1(x1)},${y - 3} l${x1 > x0 ? -7 : 7},-6 l${x1 > x0 ? 1 : -1},7 z" fill="${on ? C.hi : C.fns[0]}"/>`);
    out.push(text((x0 + x1) / 2, y - h - 6, j.label ?? `${j.to - j.from >= 0 ? "+" : ""}${fmtNum(j.to - j.from)}`, { size: 12, color: on ? C.hi : C.text }));
  });
  // Spans: brackets below.
  const spanY = y + 34;
  n.spans.forEach((sp, i) => {
    if (!shown(sp.from_step)) return;
    const on = hi.has(sp.id);
    const yy = spanY + i * 30;
    out.push(brace(X(sp.from), X(sp.to), yy, false, on ? C.hi : C.muted));
    if (sp.label) out.push(text((X(sp.from) + X(sp.to)) / 2, yy + 22, sp.label, { size: 12, color: on ? C.hi : C.text }));
  });
  // Points.
  for (const p of n.points) {
    if (!shown(p.from_step)) continue;
    const on = hi.has(p.id);
    const isAsk = n.ask === p.id;
    out.push(`<circle cx="${r1(X(p.value))}" cy="${y}" r="${on ? 6 : 5}" fill="${on ? C.hi : isAsk ? C.ok : C.fns[1]}" stroke="#0f172a" stroke-width="1.2"/>`);
    const t = revealed(p.unknown, p.reveal_step) ? (p.label ? `${p.label}` : fmtNum(p.value)) : "?";
    out.push(text(X(p.value), y - 12 - (n.jumps.length ? 0 : 0), t, { size: 12, bold: true, color: on ? C.hi : C.text }));
  }
  const H = spanY + n.spans.length * 30 + (n.spans.length ? 14 : 0);
  return svgWrap(W, Math.max(H, y + 34), out.join(""));
}

// ── Probability tree ──────────────────────────────────────────────────

type PNode = { id: string; label: string; p: string | number; children?: PNode[]; from_step?: number };

function probTree(t: Extract<StrategySpec, { type: "prob_tree" }>, s: Extract<StrategySolved, { type: "prob_tree" }> | undefined, hi: Set<string>, shown: (f?: number) => boolean, en: boolean): string {
  const depth = (ns: PNode[]): number => Math.max(...ns.map((n) => 1 + (n.children?.length ? depth(n.children) : 0)));
  const D = depth(t.children);
  const colW = 120;
  const rowH = 30;
  const top = 34;
  const colX = (level: number) => 30 + level * colW;
  const probX = colX(D) + 56;
  const asked = new Set(t.ask ?? []);
  const leafP = new Map((s?.leaves ?? []).map((l) => [l.ids[l.ids.length - 1], l.p]));
  // Pass 1: positions (leaves one per row; a parent sits in the middle of its children).
  const pos = new Map<string, { x: number; y: number }>();
  let leafRow = 0;
  const layout = (ns: PNode[], level: number): number[] =>
    ns.map((n) => {
      const y = n.children?.length ? (() => {
        const ys = layout(n.children!, level + 1);
        return (ys[0] + ys[ys.length - 1]) / 2;
      })() : top + leafRow++ * rowH + rowH / 2;
      pos.set(n.id, { x: colX(level), y });
      return y;
    });
  const rootYs = layout(t.children, 1);
  const root = { x: 30, y: (rootYs[0] + rootYs[rootYs.length - 1]) / 2 };
  // Pass 2: draw.
  const out: string[] = [`<circle cx="${root.x}" cy="${r1(root.y)}" r="4" fill="${C.stroke}"/>`];
  const draw = (ns: PNode[], from: { x: number; y: number; w: number }) => {
    for (const n of ns) {
      if (!shown(n.from_step)) continue;
      const p = pos.get(n.id)!;
      const on = hi.has(n.id);
      const x0 = from.x + from.w;
      out.push(`<line x1="${r1(x0)}" y1="${r1(from.y)}" x2="${r1(p.x - 4)}" y2="${r1(p.y)}" stroke="${on ? C.hi : C.stroke}" stroke-width="${on ? 2.2 : 1.3}"/>`);
      out.push(text((x0 + p.x) / 2, (from.y + p.y) / 2 - 6, String(n.p), { size: 11, color: on ? C.hi : C.fns[0] }));
      out.push(text(p.x, p.y + 4, n.label, { size: 13, anchor: "start", color: on ? C.hi : C.text, bold: on }));
      const w = 8 + n.label.length * 13;
      if (n.children?.length) draw(n.children, { x: p.x, y: p.y, w });
      else {
        const isAsk = asked.has(n.id);
        out.push(`<line x1="${r1(p.x + w)}" y1="${r1(p.y)}" x2="${probX - 8}" y2="${r1(p.y)}" stroke="${C.grid}" stroke-dasharray="2 3"/>`);
        out.push(text(probX, p.y + 4, `${leafP.get(n.id) ?? ""}${isAsk ? "  ✓" : ""}`, { size: 12, anchor: "start", color: isAsk ? C.ok : C.muted, bold: isAsk }));
      }
    }
  };
  draw(t.children, { x: root.x, y: root.y, w: 4 });
  t.levels?.forEach((l, i) => out.push(text(colX(i + 1), 18, l, { size: 11, color: C.muted, anchor: "start" })));
  out.push(text(probX, 18, en ? "probability" : "概率", { size: 11, color: C.muted, anchor: "start" }));
  let H = top + leafRow * rowH + 6;
  if (s?.event) {
    out.push(text(probX, H + 10, `P(✓) = ${s.event}`, { size: 13, anchor: "start", color: C.ok, bold: true }));
    H += 24;
  }
  return svgWrap(probX + 110, H, out.join(""));
}

// ── Enumeration table ─────────────────────────────────────────────────

function enumTable(e: Extract<StrategySpec, { type: "enum_table" }>, s: Extract<StrategySolved, { type: "enum_table" }> | undefined, hi: Set<string>, shown: (f?: number) => boolean, en: boolean): string {
  if (!s) return svgWrap(200, 30, text(100, 20, en ? "no table" : "无表格", { color: C.muted }));
  const ids = [...e.vars.map((v) => ({ id: v.id, from: undefined as number | undefined })), ...e.columns.map((c) => ({ id: c.id, from: c.from_step }))];
  const visible = ids.map((c, i) => ({ ...c, i, label: s.header[i] })).filter((c) => shown(c.from));
  const colW = visible.map((c) => Math.max(56, 18 + c.label.length * 13));
  const okW = 34;
  const rowH = 24;
  const W = colW.reduce((a, b) => a + b, 0) + okW + 2;
  const out: string[] = [];
  let x = 1;
  visible.forEach((c, k) => {
    const on = hi.has(c.id);
    out.push(`<rect x="${r1(x)}" y="1" width="${colW[k]}" height="${rowH}" fill="${on ? C.hiFill : "rgba(148,163,184,0.15)"}" stroke="${C.grid}"/>`);
    out.push(text(x + colW[k] / 2, 17, c.label, { size: 12, bold: true, color: on ? C.hi : C.text }));
    x += colW[k];
  });
  out.push(`<rect x="${r1(x)}" y="1" width="${okW}" height="${rowH}" fill="rgba(148,163,184,0.15)" stroke="${C.grid}"/>`);
  s.rows.forEach((row, ri) => {
    const y = 1 + (ri + 1) * rowH;
    let xx = 1;
    if (row.ok) out.push(`<rect x="1" y="${y}" width="${W - 2}" height="${rowH}" fill="${C.okFill}"/>`);
    visible.forEach((c, k) => {
      const on = hi.has(c.id);
      out.push(`<rect x="${r1(xx)}" y="${y}" width="${colW[k]}" height="${rowH}" fill="none" stroke="${C.grid}"/>`);
      out.push(text(xx + colW[k] / 2, y + 16, fmtNum(row.values[c.i]), { size: 12, color: row.ok ? C.ok : on ? C.hi : C.text, bold: row.ok }));
      xx += colW[k];
    });
    out.push(`<rect x="${r1(xx)}" y="${y}" width="${okW}" height="${rowH}" fill="none" stroke="${C.grid}"/>`);
    out.push(text(xx + okW / 2, y + 16, row.ok ? "✓" : "✗", { size: 12, color: row.ok ? C.ok : C.muted }));
  });
  const H = 1 + (s.rows.length + 1) * rowH;
  const foot = en ? `${s.tried} cases tried, ${s.matching} fit${s.truncated ? " (first rows shown)" : ""}` : `试了 ${s.tried} 种，符合 ${s.matching} 种${s.truncated ? "（只列出前面几行）" : ""}`;
  out.push(text(1, H + 18, foot, { size: 11, anchor: "start", color: C.muted }));
  return svgWrap(Math.max(W, 220), H + 26, out.join(""));
}

// ── Graph with a slider ───────────────────────────────────────────────

function graph(g: Extract<StrategySpec, { type: "graph_explore" }>, hi: Set<string>, shown: (f?: number) => boolean, param: number | undefined, en: boolean): string {
  const W = 480;
  const H = 320;
  const pad = { l: 34, r: 12, t: 12, b: 26 };
  const [x0, x1] = g.x;
  const [y0, y1] = g.y;
  const X = (x: number) => pad.l + ((x - x0) / (x1 - x0)) * (W - pad.l - pad.r);
  const Y = (y: number) => pad.t + ((y1 - y) / (y1 - y0)) * (H - pad.t - pad.b);
  const out: string[] = [];
  const sx = niceStep(x1 - x0, 8);
  const sy = niceStep(y1 - y0, 6);
  for (let v = Math.ceil(x0 / sx) * sx; v <= x1 + 1e-9; v += sx) {
    out.push(`<line x1="${r1(X(v))}" y1="${pad.t}" x2="${r1(X(v))}" y2="${H - pad.b}" stroke="${C.grid}" stroke-width="0.6"/>`);
    out.push(text(X(v), H - pad.b + 15, fmtNum(v), { size: 10, color: C.muted }));
  }
  for (let v = Math.ceil(y0 / sy) * sy; v <= y1 + 1e-9; v += sy) {
    out.push(`<line x1="${pad.l}" y1="${r1(Y(v))}" x2="${W - pad.r}" y2="${r1(Y(v))}" stroke="${C.grid}" stroke-width="0.6"/>`);
    out.push(text(pad.l - 5, Y(v) + 4, fmtNum(v), { size: 10, color: C.muted, anchor: "end" }));
  }
  if (x0 <= 0 && x1 >= 0) out.push(`<line x1="${r1(X(0))}" y1="${pad.t}" x2="${r1(X(0))}" y2="${H - pad.b}" stroke="${C.muted}" stroke-width="1.2"/>`);
  if (y0 <= 0 && y1 >= 0) out.push(`<line x1="${pad.l}" y1="${r1(Y(0))}" x2="${W - pad.r}" y2="${r1(Y(0))}" stroke="${C.muted}" stroke-width="1.2"/>`);
  const pv = param ?? g.param?.start ?? g.param?.min ?? 0;
  const scope = (x: number) => ({ x, ...(g.param ? { [g.param.id]: pv } : {}) });
  const vars = g.param ? [g.param.id] : [];
  const fns = new Map<string, (x: number) => number>();
  g.functions.forEach((f, i) => {
    let c: (s: Record<string, number>) => number;
    try {
      c = compileExprVars(f.expr, vars);
    } catch {
      return;
    }
    const fn = (x: number) => c(scope(x));
    fns.set(f.id, fn);
    if (!shown(f.from_step)) return;
    const on = hi.has(f.id);
    const segs: string[] = [];
    let cur: string[] = [];
    const N = 400;
    for (let k = 0; k <= N; k++) {
      const x = x0 + ((x1 - x0) * k) / N;
      const y = fn(x);
      if (!Number.isFinite(y) || y < y0 - (y1 - y0) || y > y1 + (y1 - y0)) {
        if (cur.length > 1) segs.push(cur.join(" "));
        cur = [];
        continue;
      }
      cur.push(`${r1(X(x))},${r1(Y(Math.max(y0 - 1e3, Math.min(y1 + 1e3, y))))}`);
    }
    if (cur.length > 1) segs.push(cur.join(" "));
    const color = on ? C.hi : C.fns[i % C.fns.length];
    for (const sg of segs) out.push(`<polyline points="${sg}" fill="none" stroke="${color}" stroke-width="${on ? 3 : 2}" stroke-linejoin="round" clip-path="url(#plot)"/>`);
    if (f.label) out.push(text(W - pad.r - 4, pad.t + 14 + i * 16, f.label, { size: 12, anchor: "end", color }));
  });
  out.unshift(`<defs><clipPath id="plot"><rect x="${pad.l}" y="${pad.t}" width="${W - pad.l - pad.r}" height="${H - pad.t - pad.b}"/></clipPath></defs>`);
  // Intersections and the optimum.
  for (const it of g.intersections) {
    if (!shown(it.from_step)) continue;
    const f = fns.get(it.fns[0]);
    if (!f) continue;
    const on = it.id ? hi.has(it.id) : false;
    const y = f(it.x);
    out.push(`<circle cx="${r1(X(it.x))}" cy="${r1(Y(y))}" r="5" fill="${on ? C.hi : C.ok}" stroke="#0f172a"/>`);
    out.push(text(X(it.x) + 8, Y(y) - 8, `(${fmtNum(it.x)}, ${fmtNum(y)})`, { size: 11, anchor: "start", color: on ? C.hi : C.text }));
  }
  if (g.optimum && shown(g.optimum.from_step)) {
    const on = g.optimum.id ? hi.has(g.optimum.id) : false;
    out.push(`<circle cx="${r1(X(g.optimum.x))}" cy="${r1(Y(g.optimum.y))}" r="6" fill="none" stroke="${on ? C.hi : C.ok}" stroke-width="2.2"/>`);
    const word = g.optimum.kind === "max" ? (en ? "max" : "最大") : en ? "min" : "最小";
    out.push(text(X(g.optimum.x) - 10, Y(g.optimum.y) + (g.optimum.kind === "max" ? -10 : 20), `${word} ${fmtNum(g.optimum.y)}`, { size: 12, bold: true, color: on ? C.hi : C.ok, anchor: "end" }));
  }
  // The point that follows the slider.
  if (g.param && g.tracer) {
    const f = fns.get(g.tracer.fn);
    const y = f ? f(pv) : NaN;
    if (Number.isFinite(y)) {
      out.push(`<line x1="${r1(X(pv))}" y1="${r1(Y(y))}" x2="${r1(X(pv))}" y2="${r1(Y(Math.max(y0, Math.min(y1, 0))))}" stroke="${C.hi}" stroke-dasharray="4 3" stroke-width="1.2"/>`);
      out.push(`<line x1="${r1(X(pv))}" y1="${r1(Y(y))}" x2="${r1(X(Math.max(x0, Math.min(x1, 0))))}" y2="${r1(Y(y))}" stroke="${C.hi}" stroke-dasharray="4 3" stroke-width="1.2"/>`);
      out.push(`<circle cx="${r1(X(pv))}" cy="${r1(Y(y))}" r="6" fill="${C.hi}" stroke="#0f172a" stroke-width="1.5"/>`);
      out.push(text(X(pv) + 9, Y(y) - 9, `${g.tracer.label ?? ""}(${fmtNum(pv)}, ${fmtNum(y)})`, { size: 12, anchor: "start", color: C.hi, bold: true }));
    }
  }
  return svgWrap(W, H, out.join(""));
}

/** Live values under a graph_explore figure for the current slider value: [{label, value}]. */
export function graphReadouts(g: Extract<StrategySpec, { type: "graph_explore" }>, param: number): Array<{ label: string; value: string }> {
  const vars = g.param ? [g.param.id] : [];
  return g.readouts.map((r) => {
    try {
      const v = compileExprVars(r.expr, vars)({ x: param, ...(g.param ? { [g.param.id]: param } : {}) });
      return { label: r.label, value: Number.isFinite(v) ? fmtNum(v) : "—" };
    } catch {
      return { label: r.label, value: "—" };
    }
  });
}
