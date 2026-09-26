/**
 * Render a solved figure to an SVG string. Pure and deterministic, so it
 * runs in the browser as well: switching the highlighted solution step
 * re-renders instantly without a server round-trip.
 *
 * Geometry is drawn with a uniform scale (angles and shapes look right);
 * a coordinate plane uses the given axis ranges. Shapes, circles and
 * functions from the spec are always drawn; `draw` adds segments, lines,
 * angle marks, equal-length ticks and labels.
 */
import { compileExpr } from "./expr";
import { renderLogicSvg } from "./logic-render";
import type { Point2, SolvedFigure } from "./spec";

export interface RenderOptions {
  width?: number;
  maxHeight?: number;
  /** Element ids to emphasise (points, segment ids or names like "AD", circle ids, function ids, angle ids). */
  highlight?: string[];
  /** Language of the diagram's own labels (logic diagrams). */
  locale?: "zh-CN" | "en-US";
}

const COLORS = {
  stroke: "#cbd5e1",
  aux: "#94a3b8",
  hi: "#f59e0b",
  point: "#e2e8f0",
  label: "#f8fafc",
  grid: "#334155",
  axis: "#94a3b8",
  fill: "#60a5fa",
  fns: ["#60a5fa", "#f472b6", "#34d399", "#fbbf24", "#a78bfa", "#fb923c"],
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const r2 = (v: number) => Math.round(v * 100) / 100;

function niceStep(range: number): number {
  const raw = range / 8;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

export function renderFigureSvg(fig: SolvedFigure, opts: RenderOptions = {}): string {
  // Logic-puzzle diagrams (grid / Venn / line-up / tree) have their own renderer.
  if (fig.spec.logic && fig.logic) return renderLogicSvg(fig.spec.logic, fig.logic, opts.highlight ?? [], opts.locale);
  const W = opts.width ?? 480;
  const maxH = opts.maxHeight ?? 380;
  const hi = new Set(opts.highlight ?? []);
  const spec = fig.spec;
  const hidden = new Set(spec.hidden_points);
  const pts = fig.points;

  // ── World bounds ────────────────────────────────────────────────────
  let xmin: number, xmax: number, ymin: number, ymax: number;
  const axes = spec.axes;
  if (axes) {
    [xmin, xmax] = axes.x[0] < axes.x[1] ? axes.x : [axes.x[1], axes.x[0]];
    [ymin, ymax] = axes.y[0] < axes.y[1] ? axes.y : [axes.y[1], axes.y[0]];
  } else {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const p of Object.values(pts)) {
      xs.push(p.x);
      ys.push(p.y);
    }
    for (const c of Object.values(fig.circles)) {
      xs.push(c.center.x - c.r, c.center.x + c.r);
      ys.push(c.center.y - c.r, c.center.y + c.r);
    }
    if (xs.length === 0) {
      xs.push(-1, 1);
      ys.push(-1, 1);
    }
    xmin = Math.min(...xs);
    xmax = Math.max(...xs);
    ymin = Math.min(...ys);
    ymax = Math.max(...ys);
    const span = Math.max(xmax - xmin, ymax - ymin, 1e-6);
    const pad = span * 0.14;
    xmin -= pad;
    xmax += pad;
    ymin -= pad;
    ymax += pad;
  }
  const spanX = Math.max(xmax - xmin, 1e-9);
  const spanY = Math.max(ymax - ymin, 1e-9);
  let sx = W / spanX;
  let sy = axes ? sx : sx;
  let H = spanY * sy;
  if (H > maxH) {
    // Too tall: shrink (geometry keeps a uniform scale; axes compress y).
    if (axes) {
      sy = maxH / spanY;
    } else {
      sx = sy = maxH / spanY;
    }
    H = maxH;
  }
  if (axes && H < 180) {
    sy = 180 / spanY;
    H = 180;
  }
  const Wd = spanX * sx;
  const X = (x: number) => r2((x - xmin) * sx);
  const Y = (y: number) => r2((ymax - y) * sy);
  const S = (p: Point2) => `${X(p.x)},${Y(p.y)}`;

  const out: string[] = [];
  const isHi = (...keys: (string | undefined)[]) => keys.some((k) => k !== undefined && hi.has(k));
  const strokeAttrs = (on: boolean, dashed?: boolean, base = COLORS.stroke) =>
    `stroke="${on ? COLORS.hi : dashed ? COLORS.aux : base}" stroke-width="${on ? 2.6 : 1.6}"${dashed ? ' stroke-dasharray="6 4"' : ""} fill="none" stroke-linecap="round" stroke-linejoin="round"`;

  // ── Grid and axes ───────────────────────────────────────────────────
  if (axes) {
    const stepX = niceStep(spanX);
    const stepY = niceStep(spanY);
    if (axes.grid !== false) {
      for (let x = Math.ceil(xmin / stepX) * stepX; x <= xmax + 1e-9; x += stepX) out.push(`<line x1="${X(x)}" y1="0" x2="${X(x)}" y2="${r2(H)}" stroke="${COLORS.grid}" stroke-width="0.6"/>`);
      for (let y = Math.ceil(ymin / stepY) * stepY; y <= ymax + 1e-9; y += stepY) out.push(`<line x1="0" y1="${Y(y)}" x2="${r2(Wd)}" y2="${Y(y)}" stroke="${COLORS.grid}" stroke-width="0.6"/>`);
    }
    const ax = Math.min(Math.max(0, xmin), xmax);
    const ay = Math.min(Math.max(0, ymin), ymax);
    out.push(`<line x1="0" y1="${Y(ay)}" x2="${r2(Wd)}" y2="${Y(ay)}" stroke="${COLORS.axis}" stroke-width="1.2"/>`);
    out.push(`<line x1="${X(ax)}" y1="0" x2="${X(ax)}" y2="${r2(H)}" stroke="${COLORS.axis}" stroke-width="1.2"/>`);
    out.push(`<path d="M${r2(Wd - 8)},${Y(ay) - 4} L${r2(Wd)},${Y(ay)} L${r2(Wd - 8)},${Y(ay) + 4}" ${strokeAttrs(false, false, COLORS.axis)}/>`);
    out.push(`<path d="M${X(ax) - 4},8 L${X(ax)},0 L${X(ax) + 4},8" ${strokeAttrs(false, false, COLORS.axis)}/>`);
    out.push(`<text x="${r2(Wd - 10)}" y="${Y(ay) - 8}" font-size="13" fill="${COLORS.axis}" font-style="italic">x</text>`);
    out.push(`<text x="${X(ax) + 8}" y="14" font-size="13" fill="${COLORS.axis}" font-style="italic">y</text>`);
    const tick = (v: number) => (Math.abs(v) < 1e-9 ? "" : String(Math.round(v * 1000) / 1000));
    // Tick numbers give way to named points (their labels sit in the same spot).
    const named = Object.entries(pts).filter(([n]) => !hidden.has(n)).map(([, p]) => ({ x: X(p.x), y: Y(p.y) }));
    const crowded = (tx: number, ty: number) => named.some((q) => Math.abs(q.x - tx) < 16 && Math.abs(q.y - ty) < 18);
    for (let x = Math.ceil(xmin / stepX) * stepX; x <= xmax + 1e-9; x += stepX) {
      if (Math.abs(x - ax) < 1e-9 || X(x) > Wd - 14 || crowded(X(x), Y(ay))) continue;
      out.push(`<text x="${X(x)}" y="${Math.min(r2(H) - 2, Y(ay) + 14)}" font-size="10" fill="${COLORS.axis}" text-anchor="middle">${tick(x)}</text>`);
    }
    for (let y = Math.ceil(ymin / stepY) * stepY; y <= ymax + 1e-9; y += stepY) {
      if (Math.abs(y - ay) < 1e-9 || Y(y) < 14 || crowded(X(ax), Y(y))) continue;
      out.push(`<text x="${X(ax) - 5}" y="${Y(y) + 3.5}" font-size="10" fill="${COLORS.axis}" text-anchor="end">${tick(y)}</text>`);
    }
    out.push(`<text x="${X(ax) - 5}" y="${Y(ay) + 13}" font-size="10" fill="${COLORS.axis}" text-anchor="end">O</text>`);
  }

  // ── Shapes from constructions ───────────────────────────────────────
  const drawnSegments = new Set<string>();
  const segKey = (a: string, b: string) => [a, b].sort().join("|");
  for (const c of spec.constructions) {
    if (c.op === "triangle" || c.op === "rectangle" || c.op === "square" || c.op === "parallelogram" || c.op === "regular_polygon") {
      const ids = [...c.ids];
      const poly = ids.map((n) => pts[n]).filter(Boolean);
      if (poly.length !== ids.length) continue;
      ids.forEach((n, i) => drawnSegments.add(segKey(n, ids[(i + 1) % ids.length])));
      out.push(`<polygon points="${poly.map(S).join(" ")}" ${strokeAttrs(isHi(ids.join("")))}/>`);
    }
  }
  for (const [cid, circ] of Object.entries(fig.circles)) {
    const dashed = spec.draw.some((d) => d.type === "circle" && d.circle === cid && d.dashed);
    out.push(`<ellipse cx="${X(circ.center.x)}" cy="${Y(circ.center.y)}" rx="${r2(circ.r * sx)}" ry="${r2(circ.r * sy)}" ${strokeAttrs(isHi(cid), dashed)}/>`);
  }

  // ── Explicit draw items ─────────────────────────────────────────────
  const clipLine = (p: Point2, q: Point2, ray: boolean): [Point2, Point2] => {
    const d = { x: q.x - p.x, y: q.y - p.y };
    const big = (spanX + spanY) * 4;
    const len = Math.hypot(d.x, d.y) || 1;
    const u = { x: (d.x / len) * big, y: (d.y / len) * big };
    return [ray ? p : { x: p.x - u.x, y: p.y - u.y }, { x: p.x + u.x, y: p.y + u.y }];
  };
  const marks: string[] = [];
  for (const d of spec.draw) {
    switch (d.type) {
      case "segment": {
        const p = pts[d.a];
        const q = pts[d.b];
        if (!p || !q) break;
        const on = isHi(d.id, d.a + d.b, d.b + d.a);
        if (!drawnSegments.has(segKey(d.a, d.b)) || on || d.dashed) {
          out.push(`<line x1="${X(p.x)}" y1="${Y(p.y)}" x2="${X(q.x)}" y2="${Y(q.y)}" ${strokeAttrs(on, d.dashed)}/>`);
          drawnSegments.add(segKey(d.a, d.b));
        }
        if (d.label) {
          const mx = (X(p.x) + X(q.x)) / 2;
          const my = (Y(p.y) + Y(q.y)) / 2;
          const nx = -(Y(q.y) - Y(p.y));
          const ny = X(q.x) - X(p.x);
          const nl = Math.hypot(nx, ny) || 1;
          marks.push(`<text x="${r2(mx + (nx / nl) * 12)}" y="${r2(my + (ny / nl) * 12 + 4)}" font-size="12" fill="${on ? COLORS.hi : COLORS.aux}" text-anchor="middle">${esc(d.label)}</text>`);
        }
        break;
      }
      case "line":
      case "ray": {
        const p = pts[d.a];
        const q = pts[d.b];
        if (!p || !q) break;
        const [s, e] = clipLine(p, q, d.type === "ray");
        out.push(`<line x1="${X(s.x)}" y1="${Y(s.y)}" x2="${X(e.x)}" y2="${Y(e.y)}" ${strokeAttrs(isHi(d.id, d.a + d.b), d.dashed)}/>`);
        break;
      }
      case "polygon": {
        const poly = d.ids.map((n) => pts[n]).filter(Boolean);
        if (poly.length !== d.ids.length) break;
        const on = isHi(d.id, d.ids.join(""));
        out.push(`<polygon points="${poly.map(S).join(" ")}" stroke="${on ? COLORS.hi : COLORS.stroke}" stroke-width="${on ? 2.6 : 1.6}" fill="${d.fill || on ? COLORS.fill : "none"}" fill-opacity="${d.fill || on ? 0.16 : 0}" stroke-linejoin="round"/>`);
        break;
      }
      case "circle":
        break; // drawn with the circles above
      case "angle": {
        const v = pts[d.vertex];
        const a = pts[d.from];
        const b = pts[d.to];
        if (!v || !a || !b) break;
        const on = isHi(d.id, d.from + d.vertex + d.to, d.to + d.vertex + d.from);
        const color = on ? COLORS.hi : COLORS.aux;
        const va = { x: X(a.x) - X(v.x), y: Y(a.y) - Y(v.y) };
        const vb = { x: X(b.x) - X(v.x), y: Y(b.y) - Y(v.y) };
        const la = Math.hypot(va.x, va.y) || 1;
        const lb = Math.hypot(vb.x, vb.y) || 1;
        const ua = { x: va.x / la, y: va.y / la };
        const ub = { x: vb.x / lb, y: vb.y / lb };
        const vx = X(v.x);
        const vy = Y(v.y);
        if (d.right) {
          const k = 10;
          marks.push(`<path d="M${r2(vx + ua.x * k)},${r2(vy + ua.y * k)} L${r2(vx + (ua.x + ub.x) * k)},${r2(vy + (ua.y + ub.y) * k)} L${r2(vx + ub.x * k)},${r2(vy + ub.y * k)}" stroke="${color}" stroke-width="1.4" fill="none"/>`);
        } else {
          const rad = 18;
          const sweep = ua.x * ub.y - ua.y * ub.x > 0 ? 1 : 0;
          marks.push(`<path d="M${r2(vx + ua.x * rad)},${r2(vy + ua.y * rad)} A${rad},${rad} 0 0 ${sweep} ${r2(vx + ub.x * rad)},${r2(vy + ub.y * rad)}" stroke="${color}" stroke-width="1.4" fill="${on ? COLORS.hi : "none"}" fill-opacity="${on ? 0.15 : 0}"/>`);
        }
        if (d.label) {
          const bis = { x: ua.x + ub.x, y: ua.y + ub.y };
          const bl = Math.hypot(bis.x, bis.y) || 1;
          marks.push(`<text x="${r2(vx + (bis.x / bl) * 32)}" y="${r2(vy + (bis.y / bl) * 32 + 4)}" font-size="12" fill="${color}" text-anchor="middle">${esc(d.label)}</text>`);
        }
        break;
      }
      case "equal_marks": {
        const n = d.count ?? 1;
        for (const [a, b] of d.segments) {
          const p = pts[a];
          const q = pts[b];
          if (!p || !q) continue;
          const mx = (X(p.x) + X(q.x)) / 2;
          const my = (Y(p.y) + Y(q.y)) / 2;
          const dx = X(q.x) - X(p.x);
          const dy = Y(q.y) - Y(p.y);
          const l = Math.hypot(dx, dy) || 1;
          const t = { x: dx / l, y: dy / l };
          const nrm = { x: -t.y, y: t.x };
          for (let k = 0; k < n; k++) {
            const off = (k - (n - 1) / 2) * 4;
            const cx = mx + t.x * off;
            const cy = my + t.y * off;
            marks.push(`<line x1="${r2(cx - nrm.x * 5)}" y1="${r2(cy - nrm.y * 5)}" x2="${r2(cx + nrm.x * 5)}" y2="${r2(cy + nrm.y * 5)}" stroke="${COLORS.aux}" stroke-width="1.4"/>`);
          }
        }
        break;
      }
      case "text": {
        const p = pts[d.at];
        if (!p) break;
        marks.push(`<text x="${X(p.x) + 8}" y="${Y(p.y) + 16}" font-size="12" fill="${COLORS.aux}">${esc(d.text)}</text>`);
        break;
      }
    }
  }

  // ── Functions ───────────────────────────────────────────────────────
  spec.functions.forEach((f, i) => {
    let fn: (x: number) => number;
    try {
      fn = compileExpr(f.expr);
    } catch {
      return;
    }
    const [d0, d1] = f.domain ?? [xmin, xmax];
    const lo = Math.max(d0, xmin);
    const hiX = Math.min(d1, xmax);
    const N = 480;
    const color = isHi(f.id) ? COLORS.hi : COLORS.fns[i % COLORS.fns.length];
    const paths: string[] = [];
    let cur: string[] = [];
    let prevY: number | undefined;
    const margin = spanY * 2;
    for (let k = 0; k <= N; k++) {
      const x = lo + ((hiX - lo) * k) / N;
      const y = fn(x);
      const bad = !Number.isFinite(y) || y > ymax + margin || y < ymin - margin || (prevY !== undefined && Math.abs(y - prevY) > spanY * 1.5);
      if (bad) {
        if (cur.length > 1) paths.push(cur.join(" "));
        cur = [];
        prevY = Number.isFinite(y) ? y : undefined;
        if (Number.isFinite(y) && y <= ymax + margin && y >= ymin - margin) cur.push(`${X(x)},${Y(y)}`);
        continue;
      }
      cur.push(`${X(x)},${Y(y)}`);
      prevY = y;
    }
    if (cur.length > 1) paths.push(cur.join(" "));
    for (const p of paths) out.push(`<polyline points="${p}" stroke="${color}" stroke-width="${isHi(f.id) ? 2.8 : 2}" fill="none" stroke-linejoin="round"/>`);
    if (f.label) {
      // Label at the right-most sample that is comfortably inside the frame.
      const inner = (y: number) => Number.isFinite(y) && y <= ymax - spanY * 0.06 && y >= ymin + spanY * 0.06;
      for (let k = 0; k <= 40; k++) {
        const xs = hiX - (hiX - lo) * (0.04 + k * 0.02);
        const ys = fn(xs);
        if (xs < lo) break;
        if (inner(ys)) {
          out.push(`<text x="${Math.min(X(xs), Wd - 4)}" y="${Math.max(12, Y(ys) - 8)}" font-size="12" fill="${color}" text-anchor="end">${esc(f.label)}</text>`);
          break;
        }
      }
    }
  });

  out.push(...marks);

  // ── Points and labels ───────────────────────────────────────────────
  // Each label goes in the direction (of 16) farthest from everything drawn
  // at that point: incident segments/edges, angle marks, circles through it,
  // the axes and curves passing through it.
  const visible = Object.entries(pts).filter(([n]) => !hidden.has(n));
  const cx = visible.reduce((s, [, p]) => s + X(p.x), 0) / Math.max(1, visible.length);
  const cy = visible.reduce((s, [, p]) => s + Y(p.y), 0) / Math.max(1, visible.length);
  const neighbours = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!neighbours.has(a)) neighbours.set(a, new Set());
    if (!neighbours.has(b)) neighbours.set(b, new Set());
    neighbours.get(a)!.add(b);
    neighbours.get(b)!.add(a);
  };
  for (const k of drawnSegments) {
    const [a, b] = k.split("|");
    link(a, b);
  }
  for (const d of spec.draw) {
    if (d.type === "line" || d.type === "ray" || d.type === "segment") link(d.a, d.b);
    if (d.type === "polygon") d.ids.forEach((n, i) => link(n, d.ids[(i + 1) % d.ids.length]));
    if (d.type === "angle") {
      link(d.vertex, d.from);
      link(d.vertex, d.to);
    }
  }
  const screenDirs = (n: string, p: Point2): number[] => {
    const px = X(p.x);
    const py = Y(p.y);
    const dirs: number[] = [];
    for (const m of neighbours.get(n) ?? []) {
      const q = pts[m];
      if (!q) continue;
      dirs.push(Math.atan2(Y(q.y) - py, X(q.x) - px));
      if (spec.draw.some((d) => (d.type === "line" && (d.a === n || d.b === n)))) dirs.push(Math.atan2(py - Y(q.y), px - X(q.x)));
    }
    // Circles through the point: the tangent directions, and inward (arcs, labels of centres).
    for (const c of Object.values(fig.circles)) {
      const dcx = X(c.center.x) - px;
      const dcy = Y(c.center.y) - py;
      const dd = Math.hypot(dcx, dcy);
      if (Math.abs(dd - c.r * sx) < 3) {
        const t = Math.atan2(dcy, dcx);
        dirs.push(t, t + Math.PI / 2, t - Math.PI / 2);
      }
    }
    if (axes) {
      if (Math.abs(p.y) < spanY * 0.02) dirs.push(0, Math.PI);
      if (Math.abs(p.x) < spanX * 0.02) dirs.push(Math.PI / 2, -Math.PI / 2);
      // Curves through the point: sample the slope.
      for (const f of spec.functions) {
        try {
          const fn = compileExpr(f.expr);
          const h = spanX * 0.01;
          if (Math.abs(fn(p.x) - p.y) < spanY * 0.01) {
            const a1 = Math.atan2(Y(fn(p.x + h)) - py, X(p.x + h) - px);
            dirs.push(a1, a1 + Math.PI);
          }
        } catch {
          /* ignore */
        }
      }
    }
    return dirs;
  };
  const angDist = (a: number, b: number) => {
    const d = Math.abs(((a - b) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI);
    return d;
  };
  for (const [n, p] of visible) {
    const px = X(p.x);
    const py = Y(p.y);
    if (px < -1 || px > Wd + 1 || py < -1 || py > H + 1) continue;
    const on = hi.has(n);
    out.push(`<circle cx="${px}" cy="${py}" r="${on ? 4 : 3}" fill="${on ? COLORS.hi : COLORS.point}"/>`);
    const dirs = screenDirs(n, p);
    const outward = Math.atan2(py - cy, px - cx);
    let best = outward;
    let bestScore = -Infinity;
    for (let k = 0; k < 16; k++) {
      const t = (k * Math.PI) / 8;
      const clearance = dirs.length ? Math.min(...dirs.map((d) => angDist(t, d))) : Math.PI;
      // Prefer clear directions, then pointing away from the figure's centre.
      const score = Math.min(clearance, Math.PI / 2) * 2 - angDist(t, outward) * 0.35;
      if (score > bestScore) {
        bestScore = score;
        best = t;
      }
    }
    const dx = Math.cos(best);
    const dy = Math.sin(best);
    const lx = Math.min(Math.max(px + dx * 14, 6), Wd - 6);
    const ly = Math.min(Math.max(py + dy * 14 + 5, 12), H - 3);
    out.push(`<text x="${r2(lx)}" y="${r2(ly)}" font-size="14" font-style="italic" fill="${on ? COLORS.hi : COLORS.label}" text-anchor="middle">${esc(n)}</text>`);
  }

  const vw = r2(Wd);
  const vh = r2(H);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-12 -12 ${r2(vw + 24)} ${r2(vh + 24)}" width="${r2(vw + 24)}" height="${r2(vh + 24)}" font-family="'Times New Roman', serif" role="img">${spec.title ? `<title>${esc(spec.title)}</title>` : ""}${out.join("")}</svg>`;
}
