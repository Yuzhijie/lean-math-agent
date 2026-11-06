/**
 * Helpers of the automation search's rules (rules.ts): reading a goal for the facts the tactics
 * need — numbers, definitions given as hypotheses, square roots, bounded variables, denominators.
 */
import { isInaccessible, type GoalState } from "../geometry/goal";

export const MAX_INTERVAL = 40;
export const NUMBERS = /(?<![\w.'])\d+(?![\w.])/g;

export const hypNames = (st: GoalState) => st.hyps.flatMap((h) => h.names).filter((n) => !isInaccessible(n));
export const isNumType = (t: string) => /^(ℕ|ℤ|ℚ|ℝ)$/.test(t.trim());

/** The goal as text for goalShape (hammer's parser). */
export function goalText(st: GoalState): string {
  return [...st.hyps.map((h) => `${h.names.join(" ")} : ${h.type}`), `⊢ ${st.target}`].join("\n");
}

/** The denominators of a text that are not plain numbers: `/ (x + 1)`, `/ x` (distinct, as written). */
export function denominators(s: string): string[] {
  const out: string[] = [];
  for (let i = s.indexOf("/ "); i >= 0; i = s.indexOf("/ ", i + 1)) {
    let j = i + 2;
    let d: string | undefined;
    if (s[j] === "(") {
      let depth = 0;
      for (let k = j; k < s.length; k++) {
        if (s[k] === "(") depth++;
        else if (s[k] === ")" && --depth === 0) {
          d = s.slice(j, k + 1);
          break;
        }
      }
    } else d = /^[A-Za-z_][\w'₀-₉]*/.exec(s.slice(j))?.[0];
    if (d && !/^\(?[\d.\s]+\)?$/.test(d) && !out.includes(d)) out.push(d);
  }
  return out;
}

/** The text of the first `|…|` in s (balanced), or undefined. */
export function firstAbs(s: string): string | undefined {
  const i = s.indexOf("|");
  if (i < 0) return undefined;
  let depth = 0;
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "|" && depth === 0) return s.slice(i + 1, j).trim();
  }
  return undefined;
}

/** `h c` for each definition `h : ∀ x, f x = …` and each `f c` (c a number) in the goal or the hypotheses. */
export function defInstances(st: GoalState): string[] {
  const out: string[] = [];
  const all = goalText(st);
  for (const h of st.hyps) {
    const n = h.names[0];
    if (h.names.length !== 1 || isInaccessible(n)) continue;
    const m = /^∀ \(?([A-Za-z_][\w'₀-₉]*)[^,]*,\s*(.*)$/.exec(h.type.replace(/\s+/g, " ").trim());
    if (!m) continue;
    const body = m[2];
    const cond = /^(.*?) → (.*)$/.exec(body);
    const eq = (cond ? cond[2] : body).trim();
    const f = new RegExp(`^([A-Za-z_][\\w'₀-₉]*) ${m[1]} = `).exec(eq)?.[1];
    if (!f) continue;
    const re = new RegExp(`(?<![\\w'.])${f} (\\(-?[\\d./ ]+\\)|\\d+)`, "g");
    for (const a of new Set([...all.matchAll(re)].map((x) => x[1]))) out.push(cond ? `${n} ${a} (by decide)` : `${n} ${a}`);
  }
  return out.slice(0, 4);
}

/** The arguments of `Real.sqrt (…)` / `√(…)` / `√x`, as written. */
export function sqrtArgs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/Real\.sqrt |√/g)) {
    let i = m.index! + m[0].length;
    if (text[i] === "(") {
      let depth = 0;
      for (let j = i; j < text.length; j++) {
        if (text[j] === "(") depth++;
        else if (text[j] === ")" && --depth === 0) {
          out.push(text.slice(i, j + 1));
          break;
        }
      }
    } else {
      const id = /^[A-Za-z_\d][\w'₀-₉]*/.exec(text.slice(i));
      if (id) out.push(id[0]);
    }
  }
  return [...new Set(out)];
}

export function gcdLcm(st: GoalState): { a: string; b: string; hg: string; hl: string } | undefined {
  let g: { a: string; b: string; h: string } | undefined;
  let l: { a: string; b: string; h: string } | undefined;
  const ARG = "(\\S+|\\([^()]*\\))";
  for (const h of st.hyps) {
    const t = h.type.trim();
    const n = h.names[0];
    const mg = new RegExp(`^(?:Nat\\.gcd ${ARG} ${ARG}|${ARG}\\.gcd ${ARG}) = \\d+$`).exec(t);
    if (mg) g = { a: mg[1] ?? mg[3], b: mg[2] ?? mg[4], h: n };
    const ml = new RegExp(`^(?:Nat\\.lcm ${ARG} ${ARG}|${ARG}\\.lcm ${ARG}) = \\d+$`).exec(t);
    if (ml) l = { a: ml[1] ?? ml[3], b: ml[2] ?? ml[4], h: n };
  }
  return g && l && g.a === l.a && g.b === l.b ? { a: g.a, b: g.b, hg: g.h, hl: l.h } : undefined;
}

/** ℕ / ℤ variables with a numeric upper bound (≤ MAX_INTERVAL) in some hypothesis, also inside ∧. */
export function boundedVars(st: GoalState): string[] {
  const vars = st.hyps.filter((h) => /^(ℕ|ℤ)$/.test(h.type.trim())).flatMap((h) => h.names).filter((v) => !isInaccessible(v));
  const facts = st.hyps.flatMap((h) => h.type.split(" ∧ ").map((x) => x.trim()));
  return vars.filter((v) => {
    const esc = v.replace(/[.*+?^${}()|[\]\\']/g, "\\$&");
    return facts.some((f) => {
      const a = new RegExp(`^${esc} (<|≤) (\\d+)$`).exec(f);
      const b = new RegExp(`^(\\d+) (>|≥) ${esc}$`).exec(f);
      const k = a ? Number(a[2]) : b ? Number(b[1]) : NaN;
      return k <= MAX_INTERVAL;
    });
  });
}
