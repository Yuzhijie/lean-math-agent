/**
 * "Pete and Sita each live 100 paces from Lin. Lin and Sita each live 50 paces from Ben. What is the order
 * of the four houses from left to right?" — the program reads the distance and left/right clues from the
 * stem, finds every order of the people that fits them, and checks that exactly one does and that it is
 * the answer. A model solver cannot be trusted here: it agreed with an answer to a question whose clues
 * contradicted each other.
 *
 * Clues read (English): "A and B each live N paces from C", "A lives N paces from B", "A's house is N
 * paces from B's", "A and B live N paces apart", "A's house is N paces to the left/right of B's",
 * "A's house is to the left/right of B's". Units: paces, steps, metres/meters, m, km, houses.
 * When two orders fit that are mirror images, a street figure whose houses are unevenly spaced (a tree
 * or something else between two of them) can tell them apart: the widest gaps must be where the figure
 * has its gaps.
 */
import { lt } from "../llm/output-locale";
import { specNodes } from "../figure/visual";

interface Q {
  stem: string;
  type: string;
  options?: string[];
  answer: string;
  figure?: { spec?: unknown };
}

type Clue = { kind: "abs"; a: string; b: string; d: number } | { kind: "diff"; left: string; right: string; d: number } | { kind: "lt"; left: string; right: string };

const LETTERS = "ABCDEFGHIJ";
const UNIT = String.raw`(?:paces?|steps?|metres?|meters?|m|km|houses?|blocks?)`;
const NUM = String.raw`(\d+(?:\.\d+)?)`;

function namesOf(option: string): string[] {
  return option
    .normalize("NFKC")
    .split(/\s*(?:,|，|、|→|->)\s*/)
    .map((x) => x.replace(/^(?:and)\s+/i, "").trim())
    .filter(Boolean);
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The clues of the stem, and whether some sentence naming two people was not understood. */
export function readClues(stem: string, names: string[]): { clues: Clue[]; unread: string[] } {
  const N = `(${names.map(esc).join("|")})(?:'s|’s)?(?:\\s+(?:house|home))?`;
  const clues: Clue[] = [];
  const unread: string[] = [];
  const sentences = stem.normalize("NFKC").replace(/’/g, "'").split(/(?<=[.!?])\s+|\n+/);
  for (const raw of sentences) {
    const s = raw.trim();
    const mentioned = names.filter((n) => new RegExp(`\\b${esc(n)}\\b`).test(s));
    if (mentioned.length < 2) continue;
    if (/\?\s*$/.test(s) || /\b(order|which|who)\b/i.test(s)) continue; // the question itself
    let m: RegExpExecArray | null;
    let found = false;
    // A and B each live N paces from C
    const each = new RegExp(`${N}\\s+and\\s+${N}\\s+(?:each|both)\\s+(?:live|lives|are|is)\\s+${NUM}\\s*${UNIT}\\s+(?:away\\s+)?from\\s+${N}`, "gi");
    while ((m = each.exec(s))) {
      clues.push({ kind: "abs", a: m[1], b: m[4], d: +m[3] }, { kind: "abs", a: m[2], b: m[4], d: +m[3] });
      found = true;
    }
    // A and B live N paces apart
    const apart = new RegExp(`${N}\\s+and\\s+${N}\\s+(?:live|are)\\s+${NUM}\\s*${UNIT}\\s+apart`, "gi");
    while ((m = apart.exec(s))) {
      clues.push({ kind: "abs", a: m[1], b: m[2], d: +m[3] });
      found = true;
    }
    // A('s house) is N paces to the left/right of B
    const side = new RegExp(`${N}\\s+(?:is|lives|live)\\s+${NUM}\\s*${UNIT}\\s+(?:to\\s+the\\s+)?(left|right)\\s+of\\s+${N}`, "gi");
    while ((m = side.exec(s))) {
      const [a, d, dir, b] = [m[1], +m[2], m[3].toLowerCase(), m[4]];
      clues.push(dir === "left" ? { kind: "diff", left: a, right: b, d } : { kind: "diff", left: b, right: a, d });
      found = true;
    }
    // A('s house) is / lives N paces from B
    const from = new RegExp(`${N}\\s+(?:is|lives|live)\\s+${NUM}\\s*${UNIT}\\s+(?:away\\s+)?from\\s+${N}`, "gi");
    while ((m = from.exec(s))) {
      clues.push({ kind: "abs", a: m[1], b: m[3], d: +m[2] });
      found = true;
    }
    // A('s house) is to the left/right of B('s house)
    const lr = new RegExp(`${N}\\s+(?:is|lives|live)\\s+(?:somewhere\\s+)?(?:to\\s+the\\s+)?(left|right)\\s+of\\s+${N}`, "gi");
    while ((m = lr.exec(s))) {
      const [a, dir, b] = [m[1], m[2].toLowerCase(), m[3]];
      clues.push(dir === "left" ? { kind: "lt", left: a, right: b } : { kind: "lt", left: b, right: a });
      found = true;
    }
    // A sentence that names people without placing them ("… are friends") is no clue.
    if (!found && /\d|\b(?:left|right|next|between|beside|nearer|closer|further|farther|apart|end)\b/i.test(s)) unread.push(s);
  }
  return { clues, unread };
}

/** Every arrangement (positions) that fits the clues; null when the distance clues do not link everyone. */
export function arrangements(names: string[], clues: Clue[]): Array<Record<string, number>> | null {
  const dist = clues.filter((c) => c.kind !== "lt") as Array<Exclude<Clue, { kind: "lt" }>>;
  const out: Array<Record<string, number>> = [];
  const fits = (p: Record<string, number>) =>
    clues.every((c) => (c.kind === "abs" ? Math.abs(Math.abs(p[c.a] - p[c.b]) - c.d) < 1e-9 : c.kind === "diff" ? Math.abs(p[c.right] - p[c.left] - c.d) < 1e-9 : p[c.left] < p[c.right])) &&
    new Set(names.map((n) => p[n])).size === names.length;
  let linked = true;
  const place = (p: Record<string, number>): void => {
    if (Object.keys(p).length === names.length) {
      if (fits(p)) out.push({ ...p });
      return;
    }
    // A clue with one person placed and one not.
    for (const c of dist) {
      const [x, y] = c.kind === "abs" ? [c.a, c.b] : [c.left, c.right];
      const xIn = x in p, yIn = y in p;
      if (xIn === yIn) continue;
      const opts = c.kind === "abs" ? (xIn ? [p[x] + c.d, p[x] - c.d] : [p[y] + c.d, p[y] - c.d]) : xIn ? [p[x] + c.d] : [p[y] - c.d];
      for (const v of opts) place({ ...p, [xIn ? y : x]: v });
      return;
    }
    linked = false; // someone is not tied to the others by a distance
  };
  place({ [names[0]]: 0 });
  return linked ? out : null;
}

const orderOf = (p: Record<string, number>) => Object.keys(p).sort((a, b) => p[a] - p[b]);
const gapsOf = (p: Record<string, number>) => {
  const v = Object.values(p).sort((a, b) => a - b);
  return v.slice(1).map((x, i) => x - v[i]);
};

/** Indices of the gaps between houses that something else stands in (a tree …), or null. */
function figureGaps(spec: unknown, houses: number): number[] | null {
  const street = specNodes(spec).find((n) => n.kind === "street") as { items?: Array<{ thing: string }> } | undefined;
  if (!street?.items) return null;
  const idx = street.items.flatMap((it, i) => (it.thing === "house" ? [i] : []));
  if (idx.length !== houses) return null;
  return idx.slice(1).flatMap((x, i) => (x - idx[i] > 1 ? [i] : []));
}

/** Null when this is not a left-to-right ordering question with distance clues the program can read. */
export function orderingCheck(c: Q): { mismatch: boolean; detail: string } | null {
  if (c.type !== "multiple_choice" || !c.options || c.options.length < 2) return null;
  if (!/\b(?:left\s+to\s+right|right\s+to\s+left)\b/i.test(c.stem)) return null;
  const lists = c.options.map(namesOf);
  const names = lists[0];
  if (names.length < 3 || names.length > 7 || !lists.every((l) => l.length === names.length && [...l].sort().join() === [...names].sort().join())) return null;
  const { clues, unread } = readClues(c.stem, names);
  if (!clues.some((x) => x.kind !== "lt")) return null;
  const rtl = /\bright\s+to\s+left\b/i.test(c.stem);
  let found = arrangements(names, clues);
  if (found === null) return unread.length ? null : { mismatch: true, detail: lt("距离条件没有把每个人的位置都联系起来，顺序不唯一", "the distance clues do not tie everyone's house to the others, so the order is not fixed") };
  if (!found.length)
    return { mismatch: true, detail: lt(`没有任何顺序能同时满足题目中的距离条件（${clueText(clues)}），题目自相矛盾`, `no order fits all the clues (${clueText(clues)}): the question contradicts itself`) };
  let orders = [...new Map(found.map((p) => [orderOf(p).join(","), p])).values()];
  // Mirror images told apart by the picture: the widest gaps sit where the figure leaves room.
  const gaps = orders.length > 1 ? figureGaps(c.figure?.spec, names.length) : null;
  if (gaps && gaps.length) {
    const keep = orders.filter((p) => {
      const g = gapsOf(p);
      const max = Math.max(...g);
      const wide = g.flatMap((x, i) => (x === max && max > Math.min(...g) ? [i] : []));
      return wide.join() === gaps.join();
    });
    if (keep.length) orders = keep;
  }
  const show = (p: Record<string, number>) => (rtl ? orderOf(p).reverse() : orderOf(p)).join(", ");
  if (orders.length > 1) {
    if (unread.length) return null; // a clue the program could not read may decide it
    return { mismatch: true, detail: lt(`有 ${orders.length} 种顺序都符合条件：${orders.map(show).join("；")}，答案不唯一`, `${orders.length} orders fit the clues: ${orders.map(show).join("; ")} — the answer is not unique`) };
  }
  const right = show(orders[0]);
  const matching = lists.flatMap((l, i) => (l.join(", ") === right ? [i] : []));
  if (matching.length !== 1) return { mismatch: true, detail: lt(`符合条件的顺序是 ${right}，${matching.length ? "有多个选项相同" : "没有一个选项是它"}`, `the order that fits is ${right}; ${matching.length ? "several options show it" : "no option shows it"}`) };
  const letter = (() => {
    const m = /^\s*\(?([A-J])\)?(?=$|[\s.、:：)．,，])/i.exec(c.answer.replace(/^(?:answer|答案)\s*[:：]?\s*/i, ""));
    return m ? LETTERS.indexOf(m[1].toUpperCase()) : c.options.findIndex((o) => o.trim() === c.answer.trim());
  })();
  if (letter !== matching[0]) return { mismatch: true, detail: lt(`符合条件的顺序是 ${right}（选项 ${LETTERS[matching[0]]}），与答案 ${c.answer} 不符`, `the order that fits is ${right} (option ${LETTERS[matching[0]]}), not the answer ${c.answer}`) };
  return { mismatch: false, detail: lt(`程序核对：只有 ${right} 符合所有条件`, `checked by the program: only ${right} fits every clue`) };
}

function clueText(clues: Clue[]): string {
  return clues
    .map((c) => (c.kind === "abs" ? `${c.a}–${c.b} ${c.d}` : c.kind === "diff" ? `${c.left} ${c.d} left of ${c.right}` : `${c.left} left of ${c.right}`))
    .join(", ");
}
