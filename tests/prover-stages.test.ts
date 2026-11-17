import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The stage table of the provers the program drives (lib/lean/prover-stages.ts): one list for the
// Lean attempt, the theorem pipeline and the sketch's holes — what runs, in which order, for how long.

const m = vi.hoisted(() => ({
  hammerTheorem: vi.fn(),
  tryTrivialProof: vi.fn(),
  verifyLeanSource: vi.fn(),
  geo: vi.fn(),
  ind: vi.fn(),
  opt: vi.fn(),
  comb: vi.fn(),
  auto: vi.fn(),
}));
vi.mock("@/lib/lean/hammer", () => ({ hammerTheorem: m.hammerTheorem }));
vi.mock("@/lib/lean/trivial-proof", () => ({ tryTrivialProof: m.tryTrivialProof }));
vi.mock("@/lib/lean/sandbox", () => ({ verifyLeanSource: m.verifyLeanSource }));
vi.mock("@/lib/lean/geometry", async (orig) => ({ ...(await orig<typeof import("@/lib/lean/geometry")>()), geometryProof: m.geo }));
vi.mock("@/lib/lean/induction", async (orig) => ({ ...(await orig<typeof import("@/lib/lean/induction")>()), inductionProof: m.ind }));
vi.mock("@/lib/lean/optimize", async (orig) => ({ ...(await orig<typeof import("@/lib/lean/optimize")>()), optimizationProof: m.opt }));
vi.mock("@/lib/lean/combinatorics", async (orig) => ({ ...(await orig<typeof import("@/lib/lean/combinatorics")>()), combinatoricsProof: m.comb }));
vi.mock("@/lib/lean/auto", async (orig) => ({ ...(await orig<typeof import("@/lib/lean/auto")>()), autoProof: m.auto }));

import { CancelledError } from "@/lib/jobs";
import { PROVER_STAGES, planStages, runProverStages, stageOf, stagesBudgetMs, triedTexts, type StageEvent, type StageStatement } from "@/lib/lean/prover-stages";
import { PROGRAM_STRATEGIES as E2E_PROGRAM } from "@/lib/e2e/outcome";
import { normalizeTheoremType } from "@/lib/llm/autoformalize";
import { withOutputLocale } from "@/lib/llm/output-locale";
import { proveWithoutModel } from "@/lib/pipeline/lean-attempt";
import { ROUTES } from "@/lib/pipeline/prover-regression";
import { holeProversFor } from "@/lib/prover/program-holes";
import { PROGRAM_STRATEGIES } from "@/lib/types";

const okVerify = { ok: true, backend: "repl", axioms: { axioms: [] }, signatureMatch: true, messages: [], log: "ok" };
const st = (theoremType: string, extra: Partial<StageStatement> = {}): StageStatement => ({ sessionId: "s", theoremName: "t", theoremType, useMathlib: true, ...extra });
const plan = (type: string, extra: Partial<StageStatement> = {}) => planStages(st(type, extra)).map((p) => p.stage.id);

// statements of the kinds the provers were written for
const EXTREMUM = ": IsGreatest {t : ℕ | ∃ F : Finset (Finset ℕ), (∀ A ∈ F, A ⊆ Finset.Icc 1 6) ∧ (∀ A ∈ F, ∀ B ∈ F, (A ∩ B).card % 2 = 0) ∧ t = F.card} 8";
const ORBITS =
  ": let Valid : Finset (Fin 12) → Prop := fun s => s.card = 4 ∧ ∀ i ∈ s, i + 1 ∉ s; let Rot : Fin 12 → Finset (Fin 12) → Finset (Fin 12) := fun k s => s.image (fun i => i + k); let Orbit : Finset (Fin 12) → Set (Finset (Fin 12)) := fun s => {t | Valid t ∧ ∃ k : Fin 12, t = Rot k s}; Set.ncard {O : Set (Finset (Fin 12)) | ∃ s : Finset (Fin 12), Valid s ∧ O = Orbit s} = 10";
// the rows of 1 … 8 in which no two neighbours differ by 1
const ROWS =
  ": let Good : Equiv.Perm (Fin 8) → Prop := fun p => ∀ i : Fin 7, Int.natAbs (((((p ⟨i.val, by omega⟩).val + 1 : ℕ) : ℤ) - (((p ⟨i.val + 1, by omega⟩).val + 1 : ℕ) : ℤ))) ≠ 1; ((Finset.univ : Finset (Equiv.Perm (Fin 8))).filter Good).card = 5242";
const SUM = ": ∀ n : ℕ, ∑ i ∈ Finset.range (n + 1), i = n * (n + 1) / 2";
const COORDS = ": ∀ (A B : ℝ × ℝ), A = (0, 0) → B = (3, 4) → Real.sqrt ((A.1 - B.1) ^ 2 + (A.2 - B.2) ^ 2) = 5";
const ORDER = ": IsLeast {n : ℕ | 0 < n ∧ (3 : ℕ) ^ 5 ∣ (2 : ℕ) ^ n - 1} 162";
const PLAIN = "(a b : ℝ) (ha : 0 < a) (hb : 0 < b) : 2 * (a * b) ≤ a ^ 2 + b ^ 2";
// the card of a filter: what the kernel decides, given time
const COUNT = ": (Finset.filter (fun s : Finset ℕ => s ⊆ Finset.Icc 1 12 ∧ s.card = 5 ∧ (∀ a ∈ s, ∀ b ∈ s, a ≠ b → 2 ≤ Nat.dist a b)) (Finset.powerset (Finset.Icc 1 12))).card = 36";
// a bound and where it is attained, without the word IsLeast
const ATTAINED = ": (∃ x y : ℕ, x * y = 24 ∧ x + y = 10) ∧ ∀ x y : ℕ, x * y = 24 → 10 ≤ x + y";

const NO = { reason: "no" };
beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.hammerTheorem.mockResolvedValue(undefined);
  m.tryTrivialProof.mockResolvedValue(null);
  m.verifyLeanSource.mockResolvedValue({ ok: false, log: "error" });
  for (const f of [m.geo, m.ind, m.opt, m.comb, m.auto]) f.mockResolvedValue(NO);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("the stage table", () => {
  it("is the one list of the program's routes: types, the regression's routes, the end-to-end report", () => {
    const ids = PROVER_STAGES.map((s) => s.id);
    expect(ids).toEqual([...PROGRAM_STRATEGIES]);
    expect([...ROUTES]).toEqual(ids);
    expect([...E2E_PROGRAM].sort()).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("lists the automation, the scripts, the provers, the fallback — each with a limit and its words in both languages", () => {
    expect(PROVER_STAGES.map((s) => `${s.id}:${s.phase}`)).toEqual(["hammer:cascade", "trivial:tactics", "order:script", "bounded:script", "geometry:prover", "induction:prover", "optimize:prover", "combinatorics:prover", "auto:fallback"]);
    // the stages whose kind of statement the single tactics never prove; a count's prover only where the program has a proof written for that count
    expect(PROVER_STAGES.filter((s) => s.beforeSingleTactics === true).map((s) => s.id)).toEqual(["order", "bounded", "geometry", "optimize"]);
    expect(PROVER_STAGES.filter((s) => typeof s.beforeSingleTactics === "function").map((s) => s.id)).toEqual(["combinatorics"]);
    for (const s of PROVER_STAGES) {
      expect(s.limitMs(), s.id).toBeGreaterThan(0);
      expect(s.minMs, s.id).toBeGreaterThan(0);
      for (const locale of ["zh-CN", "en-US"] as const) {
        withOutputLocale(locale, () => {
          const t = s.texts();
          for (const text of [t.tried("why"), t.passed("simp"), t.failed("why"), t.title("simp"), t.done]) expect(text.trim().length, `${s.id} ${locale}`).toBeGreaterThan(3);
          // a prover's reason is in what it says; a stage that announces itself also says when it fails
          if (s.phase === "prover" || s.phase === "fallback") expect(t.tried("why-7")).toContain("why-7");
          if (s.phase !== "cascade" && s.phase !== "tactics") expect(t.trying).toBeTruthy();
        });
      }
    }
    // the words follow the request's language, so they are made when asked for
    expect(withOutputLocale("en-US", () => stageOf("geometry").texts().done)).toMatch(/coordinate/i);
    expect(withOutputLocale("zh-CN", () => stageOf("geometry").texts().done)).toContain("坐标");
  });

  it("reads the limits from the environment, the prover's own variables", () => {
    expect(stageOf("geometry").limitMs()).toBe(600_000);
    expect(stageOf("auto").limitMs()).toBe(60_000);
    expect(stagesBudgetMs()).toBe(900_000);
    vi.stubEnv("GEOMETRY_TIME_LIMIT_MS", "90000");
    vi.stubEnv("PROVER_STAGES_BUDGET_MS", "120000");
    vi.stubEnv("AUTO_TIME_LIMIT_MS", "nonsense");
    expect(stageOf("geometry").limitMs()).toBe(90_000);
    expect(stagesBudgetMs()).toBe(120_000);
    expect(stageOf("auto").limitMs()).toBe(60_000);
  });
});

describe("the order of the stages on a statement", () => {
  it("runs the prover whose kind of statement it is first", () => {
    // an extremum: its prover right after the cascade — no longer induction first, nor the single tactics
    expect(plan(EXTREMUM)).toEqual(["hammer", "optimize", "trivial", "induction", "combinatorics", "auto"]);
    expect(planStages(st(EXTREMUM)).map((p) => p.fit)).toEqual([1, 2, 1, 1, 1, 1]);
    // "attained ∧ bounded" is an extremum too
    expect(plan(ATTAINED)).toEqual(["hammer", "optimize", "trivial", "induction", "auto"]);
    // coordinates: their prover, then the single tactics, and no tactic search
    expect(plan(COORDS)).toEqual(["hammer", "geometry", "trivial"]);
    // a count of orbits: the program has its proof written — right after the cascade, before
    // optimization (whose gate its lets pass) and before the single tactics
    expect(plan(ORBITS)).toEqual(["hammer", "combinatorics", "trivial", "optimize", "auto"]);
    // so has a count of rows: the single tactics would decide it over all 40 320 permutations
    expect(plan(ROWS)).toEqual(["hammer", "combinatorics", "trivial", "auto"]);
    expect(plan(ROWS.replace("≠ 1", "≥ 2"))).toEqual(["hammer", "combinatorics", "trivial", "auto"]);
    // the card of a filter is a count too: combinatorics before induction, whose gate the ∀ and the
    // range pass — after the single tactics: a long `decide +kernel` is how such a count is often proved
    expect(plan(COUNT)).toEqual(["hammer", "trivial", "combinatorics", "induction", "auto"]);
    expect(planStages(st(COUNT)).map((p) => p.fit)).toEqual([1, 1, 2, 1, 1]);
    // equal fit: the table's order
    expect(plan(SUM)).toEqual(["hammer", "trivial", "induction", "combinatorics", "auto"]);
    // nothing special: the automation and the search
    expect(plan(PLAIN)).toEqual(["hammer", "trivial", "auto"]);
  });

  it("puts the program's own scripts right after the cascade, and leaves out what cannot run", () => {
    expect(plan(ORDER).slice(0, 4)).toEqual(["hammer", "order", "optimize", "trivial"]);
    // a power too big to compute: only the order script, which splits it
    expect(plan(ORDER, { huge: true })).toEqual(["order"]);
    expect(plan(SUM, { huge: true })).toEqual([]);
    // without the REPL there is no cascade in tactic mode
    vi.stubEnv("LEAN_SERVER_MODE", "spawn");
    expect(plan(PLAIN)).toEqual(["trivial", "auto"]);
    expect(plan(COORDS)).toEqual(["geometry", "trivial"]);
  });

  it("gives a sketch hole the provers and the search only", () => {
    expect(planStages(st(EXTREMUM), ["prover", "fallback"]).map((p) => p.stage.id)).toEqual(["optimize", "induction", "combinatorics", "auto"]);
    expect(holeProversFor(EXTREMUM)).toEqual(["optimize", "induction", "combinatorics", "auto"]);
    expect(holeProversFor(COORDS)).toEqual(["geometry"]);
  });

  it("puts the prover that proves a statement first, on every statement of the regression list", () => {
    const cases = (JSON.parse(readFileSync(path.join(process.cwd(), "bench", "provers.json"), "utf8")) as { cases: { id: string; type: string; expect?: string }[] }).cases;
    const provers = new Set(PROVER_STAGES.filter((s) => s.phase === "prover").map((s) => s.id as string));
    let checked = 0;
    for (const c of cases) {
      if (!c.expect || !provers.has(c.expect)) continue;
      const first = planStages(st(normalizeTheoremType(c.type))).find((p) => p.stage.phase === "prover");
      expect(first?.stage.id, c.id).toBe(c.expect);
      checked++;
    }
    expect(checked).toBeGreaterThan(80);
  });
});

describe("running the stages", () => {
  it("stops at the first proof Lean accepts and says which stage found it, with every stage's time", async () => {
    m.opt.mockResolvedValue({ proof: { verification: okVerify, source: "theorem t … := by decide", tactics: "decide", extra: 1 }, reason: "" });
    const events: StageEvent[] = [];
    const r = await runProverStages(st(EXTREMUM), { onStage: (e) => events.push(e) });
    expect(r.proof).toEqual({ verification: okVerify, source: "theorem t … := by decide", tactics: "decide", attempts: 1, strategy: "optimize" });
    expect(r.runs.map((x) => `${x.id}:${x.outcome}`)).toEqual(["hammer:failed", "optimize:proved"]);
    expect(r.runs.every((x) => x.ms >= 0)).toBe(true);
    expect(m.ind).not.toHaveBeenCalled();
    expect(m.comb).not.toHaveBeenCalled();
    expect(events.map((e) => `${e.type}:${e.stage.id}`)).toEqual(["start:hammer", "failed:hammer", "start:optimize", "proved:optimize"]);
    expect(m.tryTrivialProof).not.toHaveBeenCalled();
    // each prover gets the statement and its own limit as the time it may take
    expect(m.opt.mock.calls[0][0]).toMatchObject({ sessionId: "s", theoremName: "t", theoremType: EXTREMUM, useMathlib: true, timeLimitMs: 180_000 });
  });

  it("verifies the cascade's tactic and the program's scripts as whole proofs", async () => {
    m.hammerTheorem.mockResolvedValue({ tactic: "omega", attempts: [], durationMs: 5 });
    m.verifyLeanSource.mockResolvedValue(okVerify);
    const r = await runProverStages(st(": (2 : ℕ) + 2 = 4", { expectedSignature: "2 + 2 = 4" }));
    expect(r.proof).toMatchObject({ strategy: "hammer", tactics: "omega", attempts: 1 });
    expect(m.verifyLeanSource.mock.calls[0][1]).toContain("omega");
    expect(m.verifyLeanSource.mock.calls[0][2]).toEqual({ theoremName: "t", expectedSignature: "2 + 2 = 4" });
    expect(m.hammerTheorem.mock.calls[0][1]).toEqual({ useMathlib: true, budgetMs: 30_000 });

    // a tactic that closed the goal in tactic mode but fails as a whole proof is no proof: the single tactics run next
    m.verifyLeanSource.mockReset().mockResolvedValue({ ok: false, log: "error" });
    m.tryTrivialProof.mockResolvedValue({ tactic: "decide", source: "src", log: "ok", verification: okVerify });
    const again = await runProverStages(st(": (2 : ℕ) + 2 = 4"));
    expect(again.proof).toMatchObject({ strategy: "trivial", tactics: "decide" });
    expect(m.tryTrivialProof.mock.calls[0][4]).toMatchObject({ deadline: expect.any(Number) });

    // the order script: each candidate verified until one passes
    m.tryTrivialProof.mockResolvedValue(null);
    m.verifyLeanSource.mockReset().mockResolvedValueOnce({ ok: false, log: "error" }).mockResolvedValue(okVerify);
    m.hammerTheorem.mockResolvedValue(undefined);
    const order = await runProverStages(st(ORDER, { huge: true }));
    expect(order.runs.map((x) => x.id)).toEqual(["order"]);
    expect(order.proof?.strategy ?? "none").toMatch(/order|none/);
  });

  it("goes on after a stage that throws, and ends when the job is cancelled", async () => {
    m.ind.mockRejectedValue(new Error("worker died\nstack"));
    m.auto.mockResolvedValue({ proof: { verification: okVerify, source: "src", tactics: "nlinarith" }, reason: "" });
    const r = await runProverStages(st(SUM));
    expect(r.proof?.strategy).toBe("auto");
    expect(r.runs.find((x) => x.id === "induction")).toMatchObject({ outcome: "failed", reason: "worker died" });

    m.comb.mockRejectedValue(new CancelledError());
    await expect(runProverStages(st(SUM))).rejects.toBeInstanceOf(CancelledError);
    // the checkpoint is asked before every stage
    let asked = 0;
    await expect(
      runProverStages(st(PLAIN), {
        checkpoint: () => {
          if (++asked === 3) throw new CancelledError();
        },
      }),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(m.auto).toHaveBeenCalledTimes(1); // only the run before
  });

  it("gives each stage the smaller of its limit and what is left, and records the stages no time was left for", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const spend = (ms: number) => async () => {
      vi.setSystemTime(Date.now() + ms);
      return NO;
    };
    m.opt.mockImplementation(spend(170_000));
    m.ind.mockImplementation(spend(100_000));
    m.comb.mockImplementation(spend(26_000));
    const r = await runProverStages(st(EXTREMUM), { budgetMs: 300_000 });
    expect(r.proof).toBeUndefined();
    expect(m.opt.mock.calls[0][0].timeLimitMs).toBe(180_000); // its own limit
    expect(m.ind.mock.calls[0][0].timeLimitMs).toBe(120_000); // its own limit: 130 s were left
    expect(m.comb.mock.calls[0][0].timeLimitMs).toBe(30_000); // what was left
    expect(m.auto).not.toHaveBeenCalled(); // 4 s left: below what the search needs to start
    expect(r.runs.map((x) => `${x.id}:${x.outcome}:${x.ms}`)).toEqual(["hammer:failed:0", "optimize:failed:170000", "trivial:failed:0", "induction:failed:100000", "combinatorics:failed:26000", "auto:skipped:0"]);
    expect(r.budgetMs).toBe(300_000);

    const tried = withOutputLocale("zh-CN", () => triedTexts(st(EXTREMUM), r));
    expect(tried[0]).toContain("自动化策略组合");
    expect(tried.some((t) => t.includes("单条策略"))).toBe(false); // the cascade's own tactics, not named twice
    expect(tried[1]).toContain("组合优化证明（no）");
    expect(tried[tried.length - 1]).toMatch(/合计 5 分钟.*没有再试：auto/);
    expect(withOutputLocale("en-US", () => triedTexts(st(EXTREMUM), r)).pop()).toMatch(/5 minutes.*not tried: auto/);
  });

  it("lets a sketch hole's prover use all that is left of the hole's time", async () => {
    await runProverStages(st(PLAIN), { budgetMs: 100_000, budgetOnly: true, phases: ["prover", "fallback"] });
    expect(m.hammerTheorem).not.toHaveBeenCalled();
    expect(m.auto.mock.calls[0][0].timeLimitMs).toBeGreaterThan(60_000);
    expect(m.auto.mock.calls[0][0].timeLimitMs).toBeLessThanOrEqual(100_000);
  });

  it("runs one route alone, or every route but one (lean:variants: the recorded route, then the others)", async () => {
    const alone = await runProverStages(st(EXTREMUM), { only: ["optimize"] });
    expect(alone.runs.map((x) => `${x.id}:${x.outcome}`)).toEqual(["optimize:failed"]);
    expect(m.hammerTheorem).not.toHaveBeenCalled();
    expect(m.ind).not.toHaveBeenCalled();
    // a route that does not take the statement runs nothing
    expect((await runProverStages(st(PLAIN), { only: ["geometry"] })).runs).toEqual([]);

    m.opt.mockClear();
    const others = await runProverStages(st(EXTREMUM), { except: ["optimize"] });
    expect(others.runs.map((x) => x.id)).toEqual(["hammer", "trivial", "induction", "combinatorics", "auto"]);
    expect(m.opt).not.toHaveBeenCalled();
  });

  describe("a statement written another way (the reading form)", () => {
    const WRITTEN = "(k : ℕ) : ∀ n' : ℕ, n' ≥ 5 + k → 2 ^ n' > n' ^ 2";
    const READ = "(k : ℕ) : ∀ o : ℕ, 5 + k ≤ o → o ^ 2 < 2 ^ o";
    const found = { proof: { verification: okVerify, source: `import Mathlib\n\ntheorem t ${READ} := by\n  intro o ho\n  induction o, ho using Nat.le_induction with\n  | base => simp\n  | succ m hm ih => omega\n`, tactics: "intro o ho\ninduction o, ho using Nat.le_induction with\n| base => simp\n| succ m hm ih => omega" }, reason: "" };

    it("the provers read it in one form; the cascade and the single tactics get it as written", async () => {
      await runProverStages(st(WRITTEN, { expectedSignature: "sig" }));
      expect(m.hammerTheorem.mock.calls[0][0]).toContain(`theorem t ${WRITTEN} := by`);
      expect(m.tryTrivialProof.mock.calls[0][2]).toBe(WRITTEN);
      expect(m.ind.mock.calls[0][0]).toMatchObject({ theoremType: READ, expectedSignature: undefined });
      expect(m.auto.mock.calls[0][0]).toMatchObject({ theoremType: READ });
      // a statement already written that way goes through as it is
      m.ind.mockClear();
      await runProverStages(st(READ, { expectedSignature: "sig" }));
      expect(m.ind.mock.calls[0][0]).toMatchObject({ theoremType: READ, expectedSignature: "sig" });
    });

    it("a proof of the reading form is checked against the statement as written: the same script, the statement's names", async () => {
      m.ind.mockResolvedValue(found);
      m.verifyLeanSource.mockResolvedValue(okVerify);
      const r = await runProverStages(st(WRITTEN, { expectedSignature: "sig" }), { only: ["induction"] });
      expect(r.proof?.strategy).toBe("induction");
      expect(r.proof?.source).toBe(`import Mathlib\n\ntheorem t ${WRITTEN} := by\n  intro n' ho\n  induction n', ho using Nat.le_induction with\n  | base => simp\n  | succ m hm ih => omega\n`);
      expect(r.proof?.tactics).toBe("intro n' ho\ninduction n', ho using Nat.le_induction with\n| base => simp\n| succ m hm ih => omega");
      expect(m.verifyLeanSource).toHaveBeenCalledTimes(1);
      expect(m.verifyLeanSource.mock.calls[0][1]).toBe(r.proof?.source);
      expect(m.verifyLeanSource.mock.calls[0][2]).toEqual({ theoremName: "t", expectedSignature: "sig" });
    });

    it("when the script does not run there, the reading form is proved inside and the statement concluded from it", async () => {
      m.ind.mockResolvedValue(found);
      m.verifyLeanSource.mockResolvedValueOnce({ ok: false, log: "error" }).mockResolvedValue(okVerify);
      const r = await runProverStages(st(WRITTEN), { only: ["induction"] });
      expect(r.proof?.tactics).toBe(
        ["have reading : ∀ (k : ℕ), ∀ n' : ℕ, 5 + k ≤ n' → n' ^ 2 < 2 ^ n' := by", "  intro k", "  intro n' ho", "  induction n', ho using Nat.le_induction with", "  | base => simp", "  | succ m hm ih => omega", "exact reading k"].join("\n"),
      );
      expect(r.proof?.source).toContain(`theorem t ${WRITTEN} := by\n  have reading : `);
      expect(m.verifyLeanSource).toHaveBeenCalledTimes(2);
    });

    it("a proof that Lean does not accept for the statement as written is no proof: the next stage runs", async () => {
      m.ind.mockResolvedValue(found);
      const r = await runProverStages(st(WRITTEN), { phases: ["prover", "fallback"] });
      expect(r.proof).toBeUndefined();
      expect(withOutputLocale("zh-CN", () => r.runs.find((x) => x.id === "induction"))).toMatchObject({ outcome: "failed" });
      expect(r.runs.find((x) => x.id === "induction")?.reason).toMatch(/carry over|搬回/);
      expect(m.auto).toHaveBeenCalled();
    });

    it("the order of the stages is decided on what the provers read", () => {
      // `≥` at the end: the bounded-minimum script reads `649 ≤ m`
      expect(plan(": ((2025 : ℤ) ∣ ((649 : ℤ)^2 - 1)) ∧ ∀ m' : ℕ, m' > 1 → (2025 : ℤ) ∣ ((m' : ℤ)^2 - 1) → m' ≥ 649")).toContain("bounded");
      expect(plan(": IsLeast {n : ℕ | n > 0 ∧ (3 : ℕ) ^ 5 ∣ (2 : ℕ) ^ n - 1} 162", { huge: true })).toEqual(["order"]);
    });
  });

  it("hands on what a prover found against the statement", async () => {
    m.opt.mockResolvedValue({ reason: "9 members", counterexample: "9 > 8: {1}, {2}, …" });
    const r = await runProverStages(st(EXTREMUM));
    expect(r.runs.find((x) => x.id === "optimize")).toMatchObject({ outcome: "failed", reason: "9 members", counterexample: "9 > 8: {1}, {2}, …" });
  });
});

describe("what was tried, in words", () => {
  it("names the single tactics only when the cascade did not run, and says what a huge power skipped", async () => {
    vi.stubEnv("LEAN_SERVER_MODE", "spawn");
    const spawn = await runProverStages(st(PLAIN));
    const zh = withOutputLocale("zh-CN", () => triedTexts(st(PLAIN), spawn));
    expect(zh[0]).toContain("单条策略");
    expect(zh[1]).toContain("策略组合搜索（no）");
    vi.unstubAllEnvs();

    const huge = await runProverStages(st(SUM, { huge: true }));
    expect(huge.runs).toEqual([]);
    expect(withOutputLocale("zh-CN", () => triedTexts({ huge: true }, huge))).toEqual(["跳过了会去直接计算的自动化策略（数太大，无法计算）"]);
  });

  it("is what proveWithoutModel returns, next to the stages' times", async () => {
    const r = await proveWithoutModel({ sessionId: "s", theoremName: "t", theoremType: SUM, useMathlib: true, huge: false });
    expect(r.proof).toBeUndefined();
    expect(r.stages.map((x) => x.id)).toEqual(["hammer", "trivial", "induction", "combinatorics", "auto"]);
    expect(r.tried).toHaveLength(4); // the cascade, induction, combinatorics, the search
    m.ind.mockResolvedValue({ proof: { verification: okVerify, source: "src", tactics: "induction n <;> simp_all" }, reason: "" });
    const ok = await proveWithoutModel({ sessionId: "s", theoremName: "t", theoremType: SUM, useMathlib: true, huge: false, budgetMs: 60_000 });
    expect(ok.proof).toMatchObject({ strategy: "induction", attempts: 1, tactics: "induction n <;> simp_all" });
    expect(ok.stages[ok.stages.length - 1]).toMatchObject({ id: "induction", outcome: "proved" });
  });
});
