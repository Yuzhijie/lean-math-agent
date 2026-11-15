/**
 * Replacement processes: "the numbers 1, …, 15 are on the board; two of them, a and b, are erased
 * and |a − b| is written; what is the largest (smallest) number that can be left?" — the let shape
 *
 *   let initial : Multiset ℤ := …
 *   let step : Multiset ℤ → Multiset ℤ → Prop := fun s t =>
 *     ∃ a b : ℤ, a ∈ s ∧ b ∈ s.erase a ∧ t = (s.erase a).erase b + ({F a b} : Multiset ℤ)
 *   let reach : Multiset ℤ → Multiset ℤ → Prop := Relation.ReflTransGen step
 *   IsGreatest {z : ℤ | reach initial ({z} : Multiset ℤ)} M          (or IsLeast; ℕ for ℤ)
 *
 * The bound is an invariant no search finds: every number stays between 0 and the largest number
 * at the start, and the parity of the sum never changes — so the last number is at most the
 * largest number of that parity, at least the smallest. The proof states the two facts about the
 * new number F once (hF: in range, same parity as a + b — omega, or every pair of the range
 * tried), carries the invariant along `Relation.ReflTransGen` by induction, and reaches M by
 * moves the program found (findMoves), each a step the kernel decides.
 *
 * Lean lists the numbers at the start and tabulates F on the range (`#eval`, outside the proof),
 * so the program plays the game with the statement's own F, however it is spelled.
 */
import type { LetDef } from "../combinatorics/lets";
import { splitLets, squash, stripParens, topIndex } from "../combinatorics/lets";

export interface ProcessShape {
  /** The let names in order (the proof's `intro`). */
  names: string[];
  lets: LetDef[];
  /** ℤ or ℕ. */
  type: "ℤ" | "ℕ";
  initial: string;
  step: string;
  reach: string;
  /** The two erased numbers as the step names them, and the number written, as written. */
  a: string;
  b: string;
  f: string;
  kind: "greatest" | "least";
  M: number;
}

/**
 * Names the proof binds itself (its variables end in an underscore, so a statement's x, z, t are
 * free to be what they are): a statement that uses one for a let or for the two numbers is left
 * to the other routes.
 */
const SCRIPT_NAMES = new Set(["hF", "hinv", "ht", "hst", "ih", "hx", "hz", "hz0", "hb0", "hs0", "ha", "hb", "ha'", "hb'", "hf0", "hf1", "hf2", "h", "h0", "h1", "h2", "h3", "h4", "f_", "e_", "z_", "t_"]);

/** The top-level conjuncts of a proposition. */
function conjuncts(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  for (;;) {
    const i = topIndex(rest, "∧");
    if (i < 0) break;
    out.push(rest.slice(0, i).trim());
    rest = rest.slice(i + 1);
  }
  out.push(rest.trim());
  return out;
}

/** The statement as a replacement process, or undefined. */
export function processShape(theoremType: string): ProcessShape | undefined {
  const sp = splitLets(theoremType);
  if (!sp || sp.lets.length < 3) return undefined;
  const body = squash(sp.body);
  const goal = /^(IsGreatest|IsLeast) \{\s*([A-Za-z_][\w']*)\s*(?::\s*(ℤ|ℕ)\s*)?\|\s*([A-Za-z_][\w']*) ([A-Za-z_][\w']*) (.+?)\s*\} \(?(\d+)(?:\s*:\s*(?:ℤ|ℕ))?\)?$/.exec(body);
  if (!goal) return undefined;
  const [, which, z, , reach, initial, last, m] = goal;
  // the set left: {z}, with or without its type
  if (!new RegExp(`^\\(?\\{\\s*${z}\\s*\\}(?:\\s*:\\s*Multiset (?:ℤ|ℕ)\\s*\\))?$`).test(last)) return undefined;
  const byName = new Map(sp.lets.map((l) => [l.name, l]));
  const reachDef = byName.get(reach);
  const initialDef = byName.get(initial);
  if (!reachDef || !initialDef) return undefined;
  const rel = /^Relation\.ReflTransGen ([A-Za-z_][\w']*)$/.exec(stripParens(squash(reachDef.value)));
  const stepDef = rel && byName.get(rel[1]);
  if (!rel || !stepDef) return undefined;
  const st = /^fun ([A-Za-z_][\w']*) ([A-Za-z_][\w']*) => ∃ ([A-Za-z_][\w']*) ([A-Za-z_][\w']*) : (ℤ|ℕ), (.+)$/.exec(stripParens(squash(stepDef.value)));
  if (!st) return undefined;
  const [, s, t, a, b, type, cond] = st;
  if (squash(initialDef.type ?? "") !== `Multiset ${type}`) return undefined;
  const parts = conjuncts(cond);
  if (parts.length !== 3 || parts[0] !== `${a} ∈ ${s}` || parts[1] !== `${b} ∈ ${s}.erase ${a}`) return undefined;
  const erased = `(${s}.erase ${a}).erase ${b}`;
  const head = `${t} = ${erased} + `;
  if (!parts[2].startsWith(head)) return undefined;
  // the number written: {F}, with or without `: Multiset T`
  let written = stripParens(parts[2].slice(head.length).trim());
  written = written.replace(new RegExp(`\\s*:\\s*Multiset ${type}$`), "").trim();
  if (!written.startsWith("{") || !written.endsWith("}")) return undefined;
  // the first brace closes at the end: one set, one number in it
  let depth = 0;
  for (let i = 0; i < written.length; i++) {
    if ("([{⟨".includes(written[i])) depth++;
    else if (")]}⟩".includes(written[i])) depth--;
    if (depth === 0 && i < written.length - 1) return undefined;
  }
  const f = written.slice(1, -1).trim();
  if (!f || topIndex(f, ",") >= 0) return undefined;
  const names = sp.lets.map((l) => l.name);
  // the proof's own names, and m1, m2, … of the moves
  if ([...names, a, b].some((x) => SCRIPT_NAMES.has(x) || /^m\d+$/.test(x))) return undefined;
  return { names, lets: sp.lets, type: type as "ℤ" | "ℕ", initial, step: rel[1], reach, a, b, f, kind: which === "IsGreatest" ? "greatest" : "least", M: Number(m) };
}

/** The largest start the program plays: the table of F is (hi + 1)², and the range is tried pair by pair as a last resort. */
export const PROCESS_MAX_VALUE = 60;
/** The most numbers at the start: one kernel-checked step per number. */
export const PROCESS_MAX_COUNT = 40;

/**
 * The command that makes Lean list the numbers at the start (in rising order) and tabulate the
 * number written for every pair of the range 0 … largest: `([1, 2, 3], [[0, 1, …], …])`. Every
 * let but the step and the relation is defined first — the board may be written with one
 * (`let n : ℕ := 15`), and so may the number written.
 */
export function processEvalCommand(shape: ProcessShape, ns = "ProcessProbe"): string {
  const { type, a, b, f } = shape;
  const defs = shape.lets.filter((l) => l.name !== shape.step && l.name !== shape.reach).map((l) => `abbrev ${l.name}${l.type ? ` : ${l.type}` : ""} := ${l.value}`);
  const hi = type === "ℤ" ? `(l.foldl max 0).toNat` : `l.foldl max 0`;
  const arg = (v: string) => (type === "ℤ" ? `(${v} : ℤ)` : v);
  return [
    `namespace ${ns}`,
    ...defs,
    `#eval`,
    `  let l := (${shape.initial}).sort (· ≤ ·)`,
    `  let hi : ℕ := min ${PROCESS_MAX_VALUE} ${hi}`,
    `  (l, (List.range (hi + 1)).map (fun i => (List.range (hi + 1)).map (fun j => (fun (${a} ${b} : ${type}) => (${f} : ${type})) ${arg("i")} ${arg("j")})))`,
    `end ${ns}`,
  ].join("\n");
}

export interface ProcessData {
  /** The numbers at the start, rising. */
  start: number[];
  /** table[a][b] = the number written for a and b. */
  table: number[][];
}

/** `([1, 2], [[0, 1], [1, 0]])` from the #eval output. */
export function readProcessData(text: string): ProcessData | undefined {
  const t = text.replace(/\s+/g, "");
  if (!/^\(\[[-\d,]*\],\[[-\d,[\]]*\]\)$/.test(t)) return undefined;
  try {
    const [start, table] = JSON.parse(`[${t.slice(1, -1)}]`) as [number[], number[][]];
    if (!Array.isArray(start) || !Array.isArray(table) || !table.every((r) => Array.isArray(r) && r.length === table.length)) return undefined;
    return { start, table };
  } catch {
    return undefined;
  }
}

/** What the invariant (every number in 0 … hi, the sum's parity) allows the last number to be. */
export function parityBounds(data: ProcessData): { hi: number; parity: number; greatest: number; least: number } {
  const hi = Math.max(0, ...data.start);
  const parity = data.start.reduce((x, y) => x + y, 0) % 2;
  return { hi, parity, greatest: hi % 2 === parity ? hi : hi - 1, least: parity };
}

/**
 * Why the invariant does not hold for this process, or undefined: the numbers at the start are
 * between 0 and the table's range, and on that range F stays in it and keeps the parity of a + b.
 */
export function invariantFault(data: ProcessData): string | undefined {
  const { start, table } = data;
  if (!start.length) return "no numbers at the start";
  if (start.length > PROCESS_MAX_COUNT) return `more than ${PROCESS_MAX_COUNT} numbers at the start`;
  const hi = Math.max(...start);
  if (Math.min(...start) < 0) return "a negative number at the start";
  if (hi > PROCESS_MAX_VALUE || table.length !== hi + 1) return `numbers above ${PROCESS_MAX_VALUE} at the start`;
  for (let a = 0; a <= hi; a++)
    for (let b = 0; b <= hi; b++) {
      const v = table[a][b];
      if (!Number.isInteger(v) || v < 0 || v > hi) return `the number written for ${a} and ${b} (${v}) leaves the range 0 … ${hi}`;
      if ((v + a + b) % 2 !== 0) return `the number written for ${a} and ${b} (${v}) changes the parity of the sum`;
    }
  return undefined;
}

/**
 * Moves that leave `target` alone on the board: pairs (a, b) in the order they are erased.
 * First with one number equal to the target kept aside while the two largest of the others are
 * taken again and again (what reaches 14 from 1 … 15: the others shrink to 0); then a search over
 * the boards, largest pairs first, that never lets the largest number fall below the target when
 * F cannot raise it again.
 */
export function findMoves(data: ProcessData, target: number, maxNodes = 200_000): [number, number][] | undefined {
  const { start, table } = data;
  const f = (a: number, b: number) => table[a][b];
  const desc = (xs: number[]) => [...xs].sort((x, y) => y - x);
  if (start.length === 1) return start[0] === target ? [] : undefined;

  // two largest, again and again
  const greedy = (xs: number[]): { moves: [number, number][]; last: number } => {
    let cur = desc(xs);
    const moves: [number, number][] = [];
    while (cur.length > 1) {
      const [a, b, ...rest] = cur;
      moves.push([a, b]);
      cur = desc([...rest, f(a, b)]);
    }
    return { moves, last: cur[0] };
  };
  const whole = greedy(start);
  if (whole.last === target) return whole.moves;
  const at = start.indexOf(target);
  if (at >= 0 && start.length > 1) {
    const g = greedy(start.filter((_, i) => i !== at));
    for (const pair of [[target, g.last], [g.last, target]] as [number, number][]) if (f(pair[0], pair[1]) === target) return [...g.moves, pair];
  }

  // F never above the larger of its two numbers: a board whose largest number is below the target is lost
  const hi = table.length - 1;
  let shrinking = true;
  for (let a = 0; a <= hi && shrinking; a++) for (let b = 0; b <= hi; b++) if (table[a][b] > Math.max(a, b)) shrinking = false;
  const seen = new Set<string>();
  let nodes = 0;
  const search = (cur: number[]): [number, number][] | undefined => {
    if (cur.length === 1) return cur[0] === target ? [] : undefined;
    if (shrinking && cur[0] < target) return undefined;
    const key = cur.join(",");
    if (seen.has(key) || ++nodes > maxNodes) return undefined;
    seen.add(key);
    for (let i = 0; i < cur.length; i++) {
      if (i > 0 && cur[i] === cur[i - 1]) continue;
      for (let j = i + 1; j < cur.length; j++) {
        if (j > i + 1 && cur[j] === cur[j - 1]) continue;
        const rest = cur.filter((_, k) => k !== i && k !== j);
        for (const [a, b] of cur[i] === cur[j] ? [[cur[i], cur[j]]] : [[cur[i], cur[j]], [cur[j], cur[i]]]) {
          const tail = search(desc([...rest, f(a, b)]));
          if (tail) return [[a, b], ...tail];
          if (f(a, b) === f(b, a)) break;
        }
      }
    }
    return undefined;
  };
  return search(desc(start));
}

/** The boards after each move (rising), the last one the single number left. */
export function boardsAfter(data: ProcessData, moves: [number, number][]): number[][] | undefined {
  let cur = [...data.start];
  const out: number[][] = [];
  for (const [a, b] of moves) {
    const i = cur.indexOf(a);
    if (i < 0) return undefined;
    cur.splice(i, 1);
    const j = cur.indexOf(b);
    if (j < 0) return undefined;
    cur.splice(j, 1);
    cur = [...cur, data.table[a][b]].sort((x, y) => x - y);
    out.push([...cur]);
  }
  return out;
}

/**
 * How "the number written is in the range and has the parity of a + b" is proved, one whole
 * verification each (a `first | … | …` with alternatives that never run is a linter warning in
 * the verified source): omega knows `Int.natAbs` and truncated subtraction; `Nat.dist`, `|a − b|`,
 * `max` / `min` and `if … then … else` are unfolded first; any other spelling is settled by
 * trying every pair of the range. The ways that fit how the number is spelled come first.
 */
export const F_TACTICS = (a: string, b: string, f = ""): string[] => {
  const ways: { tactic: string; fits: boolean }[] = [
    { tactic: `omega`, fits: !/Nat\.dist|\bif\b|\bmax\b|\bmin\b|\|/.test(f) },
    { tactic: `simp only [Nat.dist]; omega`, fits: /Nat\.dist/.test(f) },
    { tactic: `split_ifs <;> omega`, fits: /\bif\b/.test(f) },
    { tactic: `simp only [max_def, min_def]; split_ifs <;> omega`, fits: /\b(max|min)\b/.test(f) },
    { tactic: `rcases abs_cases (${a} - ${b}) with ⟨h, _⟩ | ⟨h, _⟩ <;> rw [h] <;> omega`, fits: f.includes("|") },
    { tactic: `interval_cases ${a} <;> interval_cases ${b} <;> decide`, fits: false },
  ];
  return [...ways.filter((w) => w.fits), ...ways.filter((w) => !w.fits)].map((w) => w.tactic);
};

/** The proof: the invariant along the process, the moves that reach M, the bound from the invariant. */
export function processScript(shape: ProcessShape, data: ProcessData, moves: [number, number][], fTactic = "omega"): string | undefined {
  const { type: T, initial, step, a, b, f, kind, M } = shape;
  const boards = boardsAfter(data, moves);
  if (!boards || !boards.length || boards[boards.length - 1].length !== 1 || boards[boards.length - 1][0] !== M) return undefined;
  const { hi, parity } = parityBounds(data);
  const F = `(${f} : ${T})`;
  const board = (xs: number[], last: boolean) => (last ? `({${xs[0]}} : Multiset ${T})` : `((([${xs.join(", ")}] : List ${T})) : Multiset ${T})`);
  const L: string[] = [`intro ${shape.names.join(" ")}`];
  // the number written: in the range, and of the parity of the two it replaces
  L.push(
    [
      `have hF : ∀ ${a} ${b} : ${T}, 0 ≤ ${a} → ${a} ≤ ${hi} → 0 ≤ ${b} → ${b} ≤ ${hi} → 0 ≤ ${F} ∧ ${F} ≤ ${hi} ∧ (${F} + ${a} + ${b}) % 2 = 0 := by`,
      `  intro ${a} ${b} h1 h2 h3 h4`,
      `  ${fTactic}`,
    ].join("\n"),
  );
  // the invariant holds along the process
  L.push(
    [
      `have hinv : ∀ t_, Relation.ReflTransGen ${step} ${initial} t_ → (∀ e_ ∈ t_, 0 ≤ e_ ∧ e_ ≤ ${hi}) ∧ t_.sum % 2 = ${parity} := by`,
      `  intro t_ ht`,
      `  induction ht with`,
      `  | refl => exact ⟨by decide, by decide⟩`,
      `  | tail _ hst ih =>`,
      `    obtain ⟨${a}, ${b}, ha, hb, rfl⟩ := hst`,
      `    have ha' := ih.1 ${a} ha`,
      `    have hb' := ih.1 ${b} (Multiset.mem_of_mem_erase hb)`,
      `    obtain ⟨hf0, hf1, hf2⟩ := hF ${a} ${b} ha'.1 ha'.2 hb'.1 hb'.2`,
      `    have h1 := Multiset.sum_erase ha`,
      `    have h2 := Multiset.sum_erase hb`,
      `    have hs0 := ih.2`,
      `    generalize ${F} = f_ at hf0 hf1 hf2 ⊢`,
      `    refine ⟨?_, ?_⟩`,
      `    · intro e_ hx`,
      `      rcases Multiset.mem_add.1 hx with h | h`,
      `      · exact ih.1 e_ (Multiset.mem_of_mem_erase (Multiset.mem_of_mem_erase h))`,
      `      · rw [Multiset.mem_singleton] at h; rw [h]; exact ⟨hf0, hf1⟩`,
      `    · rw [Multiset.sum_add, Multiset.sum_singleton]`,
      `      omega`,
    ].join("\n"),
  );
  L.push(`constructor`);
  // M is reached: one kernel-checked step per move
  const chain: string[] = [`· show Relation.ReflTransGen ${step} ${initial} ({${M}} : Multiset ${T})`];
  if (!moves.length) chain.push(`  have h0 : ${initial} = ({${M}} : Multiset ${T}) := by decide`, `  rw [h0]`);
  moves.forEach(([x, y], i) => {
    const from = i === 0 ? initial : board(boards[i - 1], false);
    chain.push(`  have m${i + 1} : ${step} ${from} ${board(boards[i], i === moves.length - 1)} := ⟨${x}, ${y}, by decide, by decide, by decide⟩`);
  });
  chain.push(`  exact ${moves.map((_, i) => `Relation.ReflTransGen.head m${i + 1} (`).join("")}Relation.ReflTransGen.refl${")".repeat(moves.length)}`);
  L.push(chain.join("\n"));
  // the bound: the last number is in the range and has the sum's parity
  L.push(
    [
      `· intro z_ hz`,
      `  obtain ⟨hb0, hs0⟩ := hinv {z_} hz`,
      `  have hz0 := hb0 z_ (Multiset.mem_singleton_self z_)`,
      `  rw [Multiset.sum_singleton] at hs0`,
      kind === "greatest" ? `  show z_ ≤ ${M}` : `  show ${M} ≤ z_`,
      `  omega`,
    ].join("\n"),
  );
  return L.join("\n");
}
