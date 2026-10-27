/**
 * Optimization statements, proved by the program in REPL tactic mode:
 *
 *  - `IsGreatest S M` / `IsLeast S M` → membership and bound (`refine ⟨?_, ?_⟩`); the bound
 *    `M ∈ upperBounds S` → `rw [mem_upperBounds]`, intro, the set's ∃ / ∧ taken apart, `x = f`
 *    substituted;
 *  - an `∃` goal (the value is attained) → Lean searches the candidates itself (`#eval`, not part
 *    of the proof: ℕ / ℤ in a growing range, `Fin n`, `Bool`, `Finset (Fin n)`, subsets of a given
 *    finset, functions `Fin n → Fin m`), the witness goes in with `refine ⟨w₁, …, ?_⟩` and the
 *    rest is decided;
 *  - a bound goal with variables → a box: each number variable bounded by `omega` with the
 *    smallest candidate that works (for a minimum `c ≤ x`, `by_contra` gives `x < c` first), finite
 *    types enumerated, subsets of a given finset by `powerset`; the kernel decides
 *    `∀ a ∈ Finset.Icc lo hi, …, H₁ → … → G` (`decide +kernel`) and the hypotheses are applied.
 */
import { parseGoal, isInaccessible, type GoalState } from "../geometry/goal";
import type { TacticRunner } from "../tactic-runner";
import type { ProofSession } from "../proof-state";
import { topIndex } from "../combinatorics/lets";
import { boundCandidates, boxKey, boxSize, candidates, finiteTypeSize, mentions, numbersIn, readSearchOutput, searchProgram, splitExists, type BoxVar, type Candidates } from "./domain";

export class Fail extends Error {}

const MAX_BOX = Number(process.env.OPTIMIZE_MAX_BOX ?? 300_000);
const MAX_SEARCH = 2_000_000;
const FINISH = ["decide", "decide +kernel", "norm_num", "simp", "rfl", "omega"];

/** Lean wraps long goals over lines; one line each (and `Fin (4 : ℕ)` as `Fin 4` in types). */
const flat = (s: string) => s.replace(/\s+/g, " ").trim();
export const typeText = (s: string) => flat(s).replace(/\((\d+) : ℕ\)/g, "$1");

function state(run: TacticRunner): GoalState {
  const g = run.goals()[0];
  const st = g ? parseGoal(g) : null;
  if (!st) throw new Fail("could not read the goal");
  return {
    target: flat(st.target),
    hyps: st.hyps.map((h) => ({ ...h, type: flat(h.type), ...(h.value !== undefined ? { value: flat(h.value) } : {}) })),
  };
}

async function apply(run: TacticRunner, tactic: string, what: string): Promise<void> {
  if (!(await run.apply(tactic))) throw new Fail(`${what}: ${run.lastError().split("\n")[0]}`);
}

/** Close the main goal with one of the finishers; true when it closed. */
async function finish(run: TacticRunner, extra: string[] = []): Promise<boolean> {
  const before = run.goals().length;
  for (const f of [...extra, ...FINISH]) if ((await run.apply(`· ${f}`)) && run.goals().length < before) return true;
  return false;
}

const isNumberType = (t: string) => /^(ℕ|ℤ)$/.test(typeText(t));
const isVarType = (t: string) => isNumberType(t) || finiteTypeSize(typeText(t)) !== undefined || /^Finset ℕ$/.test(typeText(t));

/** intro one binder / hypothesis of a ∀ or → goal. */
async function introOne(run: TacticRunner, target: string): Promise<boolean> {
  const all = /^∀\s*⦃?\(?([A-Za-z_][\w'₀-₉]*)/.exec(target);
  if (all) return (await run.apply(`intro ${all[1]}`)) || (await run.apply("intro"));
  return run.apply(`intro ${run.fresh("h")}`);
}

/** Take hypotheses apart: membership in set-builder sets, ∃ and ∧; then substitute `x = f`. */
async function destructure(run: TacticRunner): Promise<void> {
  // sets behind lets (`hx : x ∈ S`) are unfolded where they are used as sets
  const st0 = state(run);
  const setLets = st0.hyps.filter((h) => h.value !== undefined && /^\{/.test(h.value)).flatMap((h) => h.names);
  if (!(setLets.length && (await run.apply(`simp only [${setLets.join(", ")}, Set.mem_setOf_eq] at *`)))) await run.apply("simp only [Set.mem_setOf_eq] at *");
  if (!run.goals().length) return;
  await run.apply("casesm* _ ∧ _, ∃ _, _");
  if (!run.goals().length) return;
  // name what `casesm` left inaccessible
  {
    const st = state(run);
    const taken = new Set(st.hyps.flatMap((h) => h.names));
    const names: string[] = [];
    let k = 0;
    for (const h of st.hyps)
      for (const n of h.names) {
        if (!isInaccessible(n)) continue;
        let name: string;
        do name = isVarType(h.type) ? `v${++k}` : `h${++k}`;
        while (taken.has(name));
        taken.add(name);
        names.push(name);
      }
    if (names.length) await run.apply(`rename_i ${names.join(" ")}`);
  }
  // x = f with x a variable: substitute
  for (let round = 0; round < 12; round++) {
    const st = state(run);
    const vars = new Set(st.hyps.filter((h) => h.value === undefined && isVarType(h.type)).flatMap((h) => h.names));
    let done = false;
    for (const h of st.hyps) {
      if (h.value !== undefined || isVarType(h.type)) continue;
      const eq = topIndex(h.type, " = ");
      if (eq < 0) continue;
      const [l, r] = [h.type.slice(0, eq).trim(), h.type.slice(eq + 3).trim()];
      const v = vars.has(l) ? l : vars.has(r) ? r : undefined;
      if (!v) continue;
      if (await run.apply(`subst ${v}`)) {
        done = true;
        break;
      }
    }
    if (!done) break;
  }
}

// ── the attained value ────────────────────────────────────────────────────────

/** The type of each binder of an ∃ goal, as Lean sees it (`refine ⟨?_, …, ?_⟩` shows them as goals). */
async function binderTypes(run: TacticRunner, n: number): Promise<string[] | undefined> {
  const mark = run.save();
  try {
    if (!(await run.apply(`refine ⟨${Array.from({ length: n + 1 }, () => "?_").join(", ")}⟩`))) return undefined;
    const gs = run.goals().slice(0, n).map((g) => { const t = parseGoal(g)?.target; return t === undefined ? undefined : flat(t); });
    return gs.every((x): x is string => !!x) ? gs : undefined;
  } finally {
    run.restore(mark);
  }
}

async function witness(run: TacticRunner, session: ProofSession, st: GoalState): Promise<void> {
  const ex = splitExists(st.target);
  if (!ex) throw new Fail("could not read the ∃");
  const raw = ex.binders.every((b) => b.type) ? ex.binders.map((b) => b.type!) : await binderTypes(run, ex.binders.length);
  const types = raw?.map(typeText);
  if (!types) throw new Fail("could not read the binders' types");
  // the body with the binder predicates (`s ⊆ X`) as conditions
  const body = [...ex.binders.filter((b) => b.pred).map((b) => `${b.name} ${b.pred!.op} ${b.pred!.rhs}`), ex.body].map((x) => `(${x})`).join(" ∧ ");
  const lets = st.hyps.filter((h) => h.value !== undefined).flatMap((h) => h.names.map((name) => ({ name, value: h.value!, type: h.type })));
  const free = st.hyps.filter((h) => h.value === undefined).flatMap((h) => h.names);
  if (mentions(body, new Set(free)).size) throw new Fail("the ∃ depends on local variables");
  const unbounded = ex.binders.filter((b, i) => isNumberType(types[i]) && !b.pred).length;
  let found: string[] | undefined;
  for (const bound of [10, 30, 100, 1000, 10_000]) {
    const cs: { name: string; c: Candidates }[] = [];
    let size = 1;
    for (const [i, b] of ex.binders.entries()) {
      const c = candidates(b, types[i], bound);
      if (!c) throw new Fail(`no candidates for a binder of type ${types[i]}`);
      cs.push({ name: b.name, c });
      size *= c.size;
    }
    if (size > MAX_SEARCH) break;
    const msgs = await session.evaluate(searchProgram(cs, body, lets), Number(process.env.OPTIMIZE_EVAL_TIMEOUT_MS ?? 60_000));
    const err = msgs.find((m) => m.severity === "error");
    if (err) throw new Fail(`the search did not run: ${err.data.split("\n")[0]}`);
    const out = msgs.map((m) => readSearchOutput(m.data)).find((x) => x);
    if (out && out.length === cs.length) {
      found = out.map((v, i) => cs[i].c.witness(v));
      break;
    }
    if (!unbounded) break; // nothing grows with the bound
  }
  if (!found) throw new Fail("no witness among the candidates");
  await apply(run, `refine ⟨${found.join(", ")}, ?_⟩`, "the witness");
  if (!(await finish(run))) throw new Fail("the witness's conditions were not decided");
}

// ── the bound ─────────────────────────────────────────────────────────────────

/** Without a finite box: squares around the statement's numbers (x² − 6x + 10 ≥ 1 from (x − 3)² ≥ 0). */
async function closeAlgebraic(run: TacticRunner): Promise<boolean> {
  const st = state(run);
  const vars = st.hyps.filter((h) => h.value === undefined && isNumberType(h.type)).flatMap((h) => h.names);
  const nums = [...new Set(numbersIn([st.target, ...st.hyps.map((h) => h.type)].join(" ")).flatMap((n) => (n % 2n === 0n ? [n, n / 2n] : [n])))].filter((n) => n <= 100n).slice(0, 6);
  const shifts = ["0", "1", ...nums.map(String)];
  const hints = vars.flatMap((v) => shifts.map((k) => `sq_nonneg ((${v} : ℤ) - ${k})`)).slice(0, 16);
  const hintsSame = vars.flatMap((v) => shifts.map((k) => `sq_nonneg (${v} - ${k})`)).slice(0, 16);
  return finish(run, [`nlinarith [${hintsSame.join(", ")}]`, `nlinarith [${hints.join(", ")}]`, "positivity", "nlinarith"]);
}

async function closeBound(run: TacticRunner): Promise<void> {
  const mark0 = run.save();
  try {
    await closeBox(run);
  } catch (e) {
    if (!(e instanceof Fail)) throw e;
    run.restore(mark0);
    if (await closeAlgebraic(run)) return;
    throw e;
  }
}

async function closeBox(run: TacticRunner): Promise<void> {
  let st = state(run);
  const varsOf = (s: GoalState) => s.hyps.filter((h) => h.value === undefined && isVarType(h.type)).flatMap((h) => h.names.map((name) => ({ name, type: typeText(h.type) })));
  const lets = new Set(st.hyps.filter((h) => h.value !== undefined).flatMap((h) => h.names));
  if (!varsOf(st).length) {
    if (await finish(run)) return;
    throw new Fail("a closed goal the kernel did not decide");
  }
  const bounds = async (allowContra: boolean): Promise<BoxVar[] | undefined> => {
    st = state(run);
    const props = st.hyps.filter((h) => h.value === undefined && !isVarType(h.type));
    const vars = varsOf(st).filter((v) => mentions([st.target, ...props.map((p) => p.type)].join("\n"), new Set([v.name])).size);
    const nums = numbersIn([st.target, ...props.map((p) => p.type)].join("\n"));
    const out: BoxVar[] = [];
    for (const v of vars) {
      if (v.type === "ℕ" || v.type === "ℤ") {
        let hi: bigint | undefined;
        let hiProof = "";
        for (const K of boundCandidates(nums)) {
          const name = run.fresh("hbox");
          if (await run.apply(`have ${name} : ${v.name} ≤ ${K} := by omega`)) {
            hi = K;
            hiProof = name;
            break;
          }
        }
        if (hi === undefined) return allowContra ? undefined : (() => { throw new Fail(`no bound found for ${v.name}`); })();
        let lo = 0n;
        let loProof = `Nat.zero_le _`;
        if (v.type === "ℤ") {
          let ok = false;
          for (const K of boundCandidates(nums)) {
            const name = run.fresh("hbox");
            if (await run.apply(`have ${name} : -${K} ≤ ${v.name} := by omega`)) {
              lo = -K;
              loProof = name;
              ok = true;
              break;
            }
          }
          if (!ok) return allowContra ? undefined : (() => { throw new Fail(`no lower bound found for ${v.name}`); })();
        }
        out.push({ name: v.name, kind: "range", type: v.type, lo, hi, loProof, hiProof });
        continue;
      }
      if (v.type === "Finset ℕ") {
        const sub = props.find((p) => new RegExp(`^${v.name} ⊆ `).test(p.type));
        if (!sub) throw new Fail(`no finite range for ${v.name}`);
        const set = sub.type.slice(sub.type.indexOf("⊆") + 1).trim();
        out.push({ name: v.name, kind: "subset", set, proof: sub.names[0], size: 1 << 16 });
        continue;
      }
      out.push({ name: v.name, kind: "type", type: v.type, size: finiteTypeSize(v.type)! });
    }
    return out;
  };
  const mark = run.save();
  let box = await bounds(true);
  if (!box) {
    // a minimum: `c ≤ x` with x unbounded above — suppose x < c
    run.restore(mark);
    if (!(await run.apply(`by_contra ${run.fresh("hlt")}`))) throw new Fail("no bound for a variable");
    await run.apply("push_neg at *");
    box = await bounds(false);
    if (!box) throw new Fail("no bound for a variable");
  }
  if (boxSize(box) > MAX_BOX) throw new Fail(`the box has ${boxSize(box)} points (at most ${MAX_BOX})`);
  st = state(run);
  const boxNames = new Set(box.map((v) => v.name));
  const locals = new Set(st.hyps.flatMap((h) => h.names));
  const hyps = st.hyps
    .filter((h) => h.value === undefined && !isVarType(h.type) && !h.names.some((n) => /^hbox\d+$/.test(n)))
    .flatMap((h) => h.names.map((name) => ({ name, type: h.type })))
    .filter((h) => {
      const used = mentions(h.type, locals);
      return [...used].some((n) => boxNames.has(n)) && [...used].every((n) => boxNames.has(n) || lets.has(n));
    });
  const goalUses = mentions(st.target, locals);
  if (![...goalUses].every((n) => boxNames.has(n) || lets.has(n))) throw new Fail("the goal mentions a variable outside the box");
  const key = boxKey(box, hyps, st.target === "False" ? "False" : st.target);
  const name = run.fresh("hkey");
  await apply(run, `have ${name} : ${key.statement} := by decide +kernel`, "the kernel's check of the box");
  await apply(run, `exact ${name} ${key.apply}`, "the box applied");
}

// ── the loop ──────────────────────────────────────────────────────────────────

export async function proveOptimization(run: TacticRunner, session: ProofSession): Promise<{ ok: boolean; reason?: string }> {
  try {
    for (let guard = 0; run.goals().length && guard < 80; guard++) {
      const st = state(run);
      const t = st.target.trim();
      if (/^(IsGreatest|IsLeast) /.test(t)) {
        await apply(run, "refine ⟨?_, ?_⟩", "IsGreatest / IsLeast");
        continue;
      }
      if (/ ∈ upperBounds /.test(t) && topIndex(t, " ∈ upperBounds ") >= 0) {
        await apply(run, "rw [mem_upperBounds]", "upper bounds");
        continue;
      }
      if (/ ∈ lowerBounds /.test(t) && topIndex(t, " ∈ lowerBounds ") >= 0) {
        await apply(run, "rw [mem_lowerBounds]", "lower bounds");
        continue;
      }
      if (/^let /.test(t)) {
        await apply(run, `intro ${/^let ([^\s:]+)/.exec(t)![1]}`, "a let");
        continue;
      }
      if (t.startsWith("∃")) {
        await witness(run, session, st);
        continue;
      }
      // `P ∧ ∀ x, A → B`: the conjunction comes first (the → belongs to the ∀ on its right)
      const and = topIndex(t, " ∧ ");
      const imp = topIndex(t, " → ");
      const isImp = t.startsWith("∀") || (imp >= 0 && !/^(∃|¬)/.test(t) && (and < 0 || imp < and));
      if (!t.startsWith("∀") && !t.startsWith("∃") && and >= 0 && (imp < 0 || and < imp)) {
        if (await finish(run, ["decide +kernel"])) continue;
        await apply(run, "refine ⟨?_, ?_⟩", "a conjunction");
        continue;
      }
      if (isImp) {
        if (!(await introOne(run, t))) throw new Fail("could not introduce");
        // all the binders and hypotheses, then take them apart
        for (let i = 0; i < 20; i++) {
          const s = state(run).target.trim();
          const [a2, i2] = [topIndex(s, " ∧ "), topIndex(s, " → ")];
          if (!(s.startsWith("∀") || (i2 >= 0 && !/^(∃|¬)/.test(s) && (a2 < 0 || i2 < a2)))) break;
          if (!(await introOne(run, s))) break;
        }
        await destructure(run);
        continue;
      }
      // membership in a set-builder set, written out or behind a let (`let S := {…}; IsGreatest S M`)
      const letNames = st.hyps.filter((h) => h.value !== undefined).flatMap((h) => h.names);
      const inLet = letNames.find((n) => new RegExp(` ∈ ${n}$`).test(t));
      if (inLet || (topIndex(t, " ∈ ") >= 0 && /\{[^}]*\|/.test(t))) {
        await apply(run, `simp only [${inLet ? `${inLet}, ` : ""}Set.mem_setOf_eq]`, "set membership");
        continue;
      }
      if (t.startsWith("∃")) {
        await witness(run, session, st);
        continue;
      }
      if (topIndex(t, " ∧ ") >= 0) {
        // a closed conjunction may be decided at once
        if (await finish(run, ["decide +kernel"])) continue;
        await apply(run, "refine ⟨?_, ?_⟩", "a conjunction");
        continue;
      }
      await closeBound(run);
    }
    return run.goals().length ? { ok: false, reason: "goals left" } : { ok: true };
  } catch (e) {
    if (e instanceof Fail) return { ok: false, reason: e.message };
    throw e;
  }
}
