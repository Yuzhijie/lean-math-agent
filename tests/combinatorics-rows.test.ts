import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { combinatorialFit, combinatoricsProof, countRefute, looksCombinatorial, writtenCount } from "@/lib/lean/combinatorics";
import { parseLevels, ROW_LEMMA, rowEvalCommand, rowScript, rowShape } from "@/lib/lean/combinatorics/rows";
import { readingForm } from "@/lib/lean/reading-form";

// Lean, as the prover drives it: what `#eval` prints and whether the written proof verifies
const lean = vi.hoisted(() => ({ evaluate: vi.fn(), verify: vi.fn(), close: vi.fn(), opened: [] as { theoremType: string }[] }));
vi.mock("@/lib/lean/tactic-runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/lean/tactic-runner")>()),
  openRunner: async (args: { theoremType: string }) => {
    lean.opened.push(args);
    // the stepwise runner is for the routes after this one: a test that reaches them fails
    return { run: new Proxy({}, { get: (_t, name) => () => { throw new Error(`the stepwise runner was used (${String(name)})`); } }), script: [], session: { evaluate: lean.evaluate, verify: lean.verify, close: lean.close } };
  },
}));

/** "the numbers at two neighbouring places do not differ by 1", the places' values as `a` and `b` */
const apart = (a: string, b: string) => `Int.natAbs ((((${a}).val + 1 : ℕ) : ℤ) - (((${b}).val + 1 : ℕ) : ℤ)) ≠ 1`;

// the statement of the session this route was written for: 1, …, 8 in a row, no two neighbours differ by 1
const EIGHT =
  ": let Good : Equiv.Perm (Fin 8) → Prop := fun p => ∀ i : Fin 7, Int.natAbs (((((p ⟨i.val, by omega⟩).val + 1 : ℕ) : ℤ) - (((p ⟨i.val + 1, by omega⟩).val + 1 : ℕ) : ℤ))) ≠ 1; ((Finset.univ : Finset (Equiv.Perm (Fin 8))).filter Good).card = 5242";
const SHORT = `: let Good : Equiv.Perm (Fin 5) → Prop := fun p => ∀ i : Fin 4, ${apart("p i.castSucc", "p i.succ")}; (Finset.univ.filter Good).card = 14`;
const GUARD = `: (Finset.filter (fun p : Equiv.Perm (Fin 5) => ∀ i : Fin 5, ∀ h : i.val + 1 < 5, ${apart("p i", "p ⟨i.val + 1, h⟩")}) Finset.univ).card = 14`;
const GUARD_ADD = `: Fintype.card {p : Equiv.Perm (Fin 5) // ∀ i : Fin 5, i.val + 1 < 5 → ${apart("p i", "p (i + 1)")}} = 14`;
const PAIR = `: let Good : Equiv.Perm (Fin 5) → Prop := fun p => ∀ i j : Fin 5, j.val = i.val + 1 → ${apart("p i", "p j")}; Set.ncard {p : Equiv.Perm (Fin 5) | Good p} = 14`;
const NAT = `: Nat.card {p : Equiv.Perm (Fin 5) // ∀ i : ℕ, ∀ h : i + 1 < 5, ${apart("p ⟨i, by omega⟩", "p ⟨i + 1, h⟩")}} = 14`;
const HELPER =
  ": let Near : Fin 6 → Fin 6 → Prop := fun a b => a.val + 1 = b.val ∨ b.val + 1 = a.val; let Good : Equiv.Perm (Fin 6) → Prop := fun p => ∀ i : Fin 5, ¬ Near (p ⟨i.val, by omega⟩) (p ⟨i.val + 1, by omega⟩); (Finset.univ.filter Good).card = 90";
const GE =
  ": let Good : Equiv.Perm (Fin 6) → Prop := fun p => ∀ i : Fin 5, ((p ⟨i.val, by omega⟩).val + 2 ≤ (p ⟨i.val + 1, by omega⟩).val) ∨ (p ⟨i.val, by omega⟩).val ≥ (p ⟨i.val + 1, by omega⟩).val + 2; (Finset.univ.filter Good).card = 90";

describe("a count of arrangements in a row", () => {
  it("reads the session's statement: the size, the number, the condition as a relation between a value and the next", () => {
    expect(rowShape(EIGHT)).toEqual({
      n: 8,
      total: 5242,
      relation: "fun x_ y_ : Fin 8 => decide (Int.natAbs (((((x_).val + 1 : ℕ) : ℤ) - (((y_).val + 1 : ℕ) : ℤ))) ≠ 1)",
      form: "short",
      count: "filter",
      lets: ["Good"],
    });
    // as a prover gets it: line breaks and the outer parentheses make no difference
    expect(rowShape(`: (${EIGHT.slice(2).replace("; ", ";\n    ")})`)).toMatchObject({ n: 8, total: 5242, form: "short" });
    expect(rowShape(EIGHT.replace("= 5242", "= (5242 : ℕ)"))?.total).toBe(5242);
  });

  it("reads the other ways of naming two neighbouring places and of writing the count", () => {
    const relation = `fun x_ y_ : Fin 5 => decide (${apart("x_", "y_")})`;
    expect(rowShape(SHORT)).toMatchObject({ n: 5, total: 14, form: "short", count: "filter", relation, lets: ["Good"] });
    expect(rowShape(GUARD)).toMatchObject({ form: "guard", count: "filter", relation, lets: [] });
    expect(rowShape(GUARD_ADD)).toMatchObject({ form: "guard-add", count: "subtype", relation });
    expect(rowShape(PAIR)).toMatchObject({ form: "pair", count: "ncard", relation, lets: ["Good"] });
    expect(rowShape(NAT)).toMatchObject({ form: "nat", count: "natcard", relation });
    // the same count written the other ways round
    expect(rowShape(SHORT.replace("(Finset.univ.filter Good).card", "Finset.card (Finset.filter Good Finset.univ)"))).toMatchObject({ form: "short", count: "filter" });
    expect(rowShape(PAIR.replace("Set.ncard {p : Equiv.Perm (Fin 5) | Good p}", "({p : Equiv.Perm (Fin 5) | Good p} : Set (Equiv.Perm (Fin 5))).ncard"))).toMatchObject({ form: "pair", count: "ncard" });
    expect(rowShape(GUARD.replace("∀ i : Fin 5, ∀ h : i.val + 1 < 5, ", "∀ (i : Fin 5) (h : i.val + 1 < 5), "))).toMatchObject({ form: "guard" });
    expect(rowShape(SHORT.replace("∀ i : Fin 4,", "∀ i : Fin (5 - 1),"))).toMatchObject({ form: "short" });
  });

  it("a helper let is written into the relation, which then needs nothing of the statement's context", () => {
    const shape = rowShape(HELPER)!;
    expect(shape).toMatchObject({ n: 6, total: 90, form: "short", lets: ["Near", "Good"] });
    expect(shape.relation).toBe("fun x_ y_ : Fin 6 => decide (¬ ((fun a b => a.val + 1 = b.val ∨ b.val + 1 = a.val) : Fin 6 → Fin 6 → Prop) (x_) (y_))");
    // names the condition already uses are not taken for the two values
    const taken = rowShape(HELPER.replaceAll("fun a b => a.val + 1 = b.val ∨ b.val + 1 = a.val", "fun x_ y_ => x_.val + 1 = y_.val ∨ y_.val + 1 = x_.val"))!;
    expect(taken.relation.startsWith("fun x__ y__ : Fin 6 => decide (")).toBe(true);
  });

  it("is read in the provers' one form: a statement with ≥ is the same count", () => {
    const reading = readingForm(GE).type;
    expect(reading).not.toContain("≥");
    expect(rowShape(reading)).toMatchObject({ n: 6, total: 90, form: "short" });
    expect(rowShape(reading)!.relation).toBe("fun x_ y_ : Fin 6 => decide (((x_).val + 2 ≤ (y_).val) ∨ (y_).val + 2 ≤ (x_).val)");
  });

  it("leaves alone what is not a condition on two neighbouring values", () => {
    const no = (t: string) => expect(rowShape(t), t).toBeUndefined();
    // a place further on, the place itself, the inverse, a fixed place
    no(SHORT.replace("p i.succ", "p ⟨i.val + 2, by omega⟩"));
    no(SHORT.replace("≠ 1", "≠ i.val"));
    no(SHORT.replace("p i.succ", "p.symm i.succ"));
    no(SHORT.replace("p i.succ", "p 0"));
    // only one of the two neighbours
    no(": (Finset.univ.filter (fun p : Equiv.Perm (Fin 5) => ∀ i : Fin 4, (p i.castSucc).val ≠ 2)).card = 96");
    // every pair of places, not the neighbouring ones
    no(`: (Finset.univ.filter (fun p : Equiv.Perm (Fin 5) => ∀ i j : Fin 5, i < j → ${apart("p i", "p j")})).card = 0`);
    // a guard that is not "there is a next place"
    no(GUARD.replace("i.val + 1 < 5", "i.val + 2 < 5"));
    // not a number of arrangements; binders; two sizes; sizes outside 2 … 12
    no(SHORT.replace("= 14", "≤ 14"));
    no(`(k : ℕ) ${SHORT.replace("= 14", "= k")}`);
    no(SHORT.replace("∀ i : Fin 4", "∀ i : Fin 4, ∀ q : Equiv.Perm (Fin 3)"));
    no(EIGHT.replaceAll("Fin 8", "Fin 13").replace("Fin 7", "Fin 12"));
    no(": (Finset.univ.filter (fun p : Equiv.Perm (Fin 1) => ∀ i : Fin 0, p i.castSucc ≠ p i.succ)).card = 1");
    // functions that are not permutations, subsets: other routes
    no(": (Finset.univ.filter (fun f : Fin 5 → Fin 5 => ∀ i : Fin 4, f i.castSucc ≠ f i.succ)).card = 1280");
    no(": (Finset.univ.filter (fun s : Finset (Fin 7) => s.card = 3)).card = 35");
    // a let with the name of one of the proof's own steps
    no(SHORT.replaceAll("Good", "row_count"));
  });

  it("is a count the program has a proof written for: its prover runs before the single tactics", () => {
    for (const t of [EIGHT, SHORT, GUARD, GUARD_ADD, PAIR, NAT, HELPER]) {
      expect(looksCombinatorial(t), t).toBe(true);
      expect(combinatorialFit(t), t).toBe(2);
      expect(writtenCount(t), t).toBe(true);
    }
    // any other count: the kernel's `decide`, given time, is how it is often proved
    expect(writtenCount(": (Finset.univ.filter (fun s : Finset (Fin 7) => s.card = 3)).card = 35")).toBe(false);
    expect(writtenCount(": Nat.card {p : Fin 5 × Fin 5 // p.1 < p.2} = 10")).toBe(false);
  });
});

describe("Lean's own count of the rows", () => {
  it("asks for the number of rows after each place — by a recurrence, so for every size", () => {
    const shape = rowShape(EIGHT)!;
    const cmd = rowEvalCommand(shape);
    expect(cmd.startsWith(`#eval\n  let R : Fin 8 → Fin 8 → Bool := (${shape.relation})\n`)).toBe(true);
    // the rows that use the same values and begin with the same one are one number
    expect(cmd).toContain("Std.HashMap (Nat × Fin 8) Nat");
    // a row grows at the front by a value not in it that the relation allows before its first — as the kernel builds them
    expect(cmd).toContain("if !key.1.testBit x.val && R x key.2 then T.insert (key.1 ||| 2 ^ x.val, x) (T.getD (key.1 ||| 2 ^ x.val, x) 0 + c) else T");
    // one place is the start, n - 1 more follow
    expect(cmd).toContain("(List.range (8 - 1)).foldl");
    expect(cmd).toContain("(start, [8])).2");
    // no row and no permutation is built, nothing is trusted to the compiler inside a proof
    expect(cmd).not.toMatch(/native_decide|Equiv\.Perm|flatMap|List \(List/);
    expect(rowEvalCommand(rowShape(NAT)!)).toContain("let R : Fin 5 → Fin 5 → Bool := (fun x_ y_ : Fin 5 => decide (");
  });

  it("reads the list Lean prints", () => {
    expect(parseLevels("[8, 42, 180, 650, 1928, 4386, 6748, 5242]")).toEqual([8, 42, 180, 650, 1928, 4386, 6748, 5242]);
    expect(parseLevels("[5, 12,\n 18, 20, 14]")).toEqual([5, 12, 18, 20, 14]);
    expect(parseLevels("[]")).toEqual([]);
    expect(parseLevels("error: failed to synthesize Decidable")).toBeUndefined();
    expect(parseLevels("[1, 2")).toBeUndefined();
  });
});

describe("the proof the program writes", () => {
  const lines = (t: string) => rowScript(rowShape(t)!).split("\n");
  const after = (t: string) => {
    const script = rowScript(rowShape(t)!);
    return script.slice(script.indexOf(ROW_LEMMA) + ROW_LEMMA.length + 1).split("\n");
  };

  it("the lets, the lemma for any n and any relation, the statement's condition read as the relation, one kernel count", () => {
    const script = rowScript(rowShape(EIGHT)!);
    expect(script.startsWith(`intro Good\n${ROW_LEMMA}\n`)).toBe(true);
    expect(after(EIGHT)).toEqual([
      "refine (row_count 8 (fun x_ y_ : Fin 8 => decide (Int.natAbs (((((x_).val + 1 : ℕ) : ℤ) - (((y_).val + 1 : ℕ) : ℤ))) ≠ 1)) _ ?_).trans ?_",
      "· intro p_",
      "  constructor",
      "  · intro H_ i_ h_",
      "    exact decide_eq_true (H_ ⟨i_.val, by omega⟩)",
      "  · intro H_ i_",
      "    exact of_decide_eq_true (H_ ⟨i_.val, by omega⟩ (by simp only []; omega))",
      "· decide +kernel",
    ]);
    // no lets: nothing to introduce
    expect(lines(GUARD)[0]).toBe(ROW_LEMMA.split("\n")[0]);
  });

  it("the lemma speaks of no particular size or condition, and trusts nothing but the kernel", () => {
    expect(ROW_LEMMA).toMatch(/^have row_enum : ∀ \(n : ℕ\) \(R : Fin n → Fin n → Bool\)/);
    expect(ROW_LEMMA).toContain("\nhave row_count : ∀ (n : ℕ) (R : Fin n → Fin n → Bool) (P : Equiv.Perm (Fin n) → Prop) [DecidablePred P],");
    expect(ROW_LEMMA).not.toMatch(/\d{2,}|Fin \d/);
    for (const t of [EIGHT, SHORT, GUARD, GUARD_ADD, PAIR, NAT, HELPER]) {
      const script = rowScript(rowShape(t)!);
      expect(script, t).not.toMatch(/native_decide|sorry|admit|first \||Lean\.ofReduceBool/);
      expect(script.endsWith("\n· decide +kernel"), t).toBe(true);
      // the tabs of the proof: every line indented by spaces only
      expect(script, t).not.toMatch(/\t/);
    }
  });

  it("each way of naming the neighbours has its two directions", () => {
    expect(after(GUARD).slice(3)).toEqual([
      "  · intro H_ i_ h_",
      "    exact decide_eq_true (H_ i_ (by omega))",
      "  · intro H_ i_ h_",
      "    exact of_decide_eq_true (H_ i_ (by omega))",
      "· decide +kernel",
    ]);
    // `p (i + 1)`: `i + 1` in Fin n is the next place where there is one — decided once for the size
    const add = after(GUARD_ADD);
    expect(add[2]).toBe("· have hadd_ : ∀ (i : Fin 5) (h : i.val + 1 < 5), i + 1 = ⟨i.val + 1, h⟩ := by decide");
    expect(add).toContain("    rw [← hadd_ i_ h_]");
    expect(add).toContain("    rw [← hadd_ i_ (by omega)] at e_");
    // two places with `j = i + 1`: j is that place
    const pair = after(PAIR);
    expect(pair).toContain("    exact decide_eq_true (H_ i_ ⟨i_.val + 1, h_⟩ rfl)");
    expect(pair).toContain("    have hb_ : i_.val + 1 < 5 := by omega");
    expect(pair).toContain("    obtain rfl : j_ = ⟨i_.val + 1, hb_⟩ := Fin.ext (by omega)");
    // places as natural numbers
    expect(after(NAT)).toContain("    exact of_decide_eq_true (H_ ⟨i_, by omega⟩ h_)");
  });

  it("each way of writing the count is first turned into the card of a filter", () => {
    expect(after(SHORT)[0]).toMatch(/^refine \(row_count 5 /);
    expect(after(GUARD_ADD).slice(0, 2)).toEqual(["rw [Fintype.card_subtype]", expect.stringMatching(/^refine \(row_count 5 /)]);
    expect(after(NAT).slice(0, 3)).toEqual(["classical", "rw [Nat.card_eq_fintype_card, Fintype.card_subtype]", expect.stringMatching(/^refine \(row_count 5 /)]);
    expect(after(PAIR).slice(0, 3)).toEqual(["classical", "rw [Set.ncard_eq_toFinset_card', Set.toFinset_ofPred]", expect.stringMatching(/^refine \(row_count 5 /)]);
  });
});

describe("the route in the prover", () => {
  // what Lean prints for these two statements (checked on the sandbox)
  const LEVELS_8 = "[8, 42, 180, 650, 1928, 4386, 6748, 5242]";
  const LEVELS_9 = "[9, 56, 294, 1332, 5110, 15912, 37566, 59612, 47622]";
  const NINE = EIGHT.replaceAll("Fin 8", "Fin 9").replace("Fin 7", "Fin 8").replace("5242", "47622");
  const prove = (theoremType: string) => combinatoricsProof({ sessionId: "s", theoremName: "rows", theoremType, useMathlib: true });

  beforeEach(() => {
    lean.evaluate.mockReset();
    lean.verify.mockReset();
    lean.close.mockReset();
    lean.opened.length = 0;
    lean.evaluate.mockResolvedValue([{ severity: "info", data: LEVELS_8 }]);
    lean.verify.mockResolvedValue({ ok: true, log: "" });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("Lean counts, the number agrees, the written proof is checked", async () => {
    const r = await prove(EIGHT);
    expect(r.proof).toMatchObject({ method: "rows", tactics: rowScript(rowShape(EIGHT)!) });
    expect(lean.evaluate).toHaveBeenCalledTimes(1);
    expect(lean.evaluate.mock.calls[0][0]).toBe(rowEvalCommand(rowShape(EIGHT)!));
    const source = lean.verify.mock.calls[0][1] as string;
    expect(source).toContain("theorem rows");
    expect(source).toContain("· decide +kernel");
    expect(lean.close).toHaveBeenCalledTimes(1);
  });

  it("another number than the statement's: a counterexample, and no proof is tried", async () => {
    const r = await prove(EIGHT.replace("5242", "5240"));
    expect(r).toEqual({ reason: "Lean counts 5242 arrangements, the statement says 5240", counterexample: "5242 ≠ 5240" });
    expect(lean.verify).not.toHaveBeenCalled();
    expect(lean.close).toHaveBeenCalledTimes(1);
  });

  it("more rows than the kernel is given: the count is said, nothing is handed to the kernel — not the permutations either", async () => {
    lean.evaluate.mockResolvedValue([{ severity: "info", data: LEVELS_9 }]);
    const r = await prove(NINE);
    expect(r.proof).toBeUndefined();
    expect(r.counterexample).toBeUndefined();
    expect(r.reason).toBe("rows: Lean counts 47622 arrangements too, but a proof would have the kernel build 167513 rows (ROWS_MAX_LISTS 40000)");
    expect(lean.verify).not.toHaveBeenCalled();
    // a wrong number is still caught at that size
    expect(await prove(NINE.replace("47622", "47620"))).toMatchObject({ counterexample: "47622 ≠ 47620" });
    // the limit is the environment's
    vi.stubEnv("ROWS_MAX_LISTS", "200000");
    expect((await prove(NINE)).proof?.method).toBe("rows");
    vi.stubEnv("ROWS_MAX_LISTS", "19183");
    lean.evaluate.mockResolvedValue([{ severity: "info", data: LEVELS_8 }]);
    expect((await prove(EIGHT)).reason).toContain("would have the kernel build 19184 rows (ROWS_MAX_LISTS 19183)");
  });

  it("a written proof Lean rejects is a reason, not a proof", async () => {
    lean.verify.mockResolvedValue({ ok: false, log: "error: unsolved goals" });
    // (the routes after this one need the stepwise runner, which this test does not have)
    const r = await prove(EIGHT);
    expect(r.proof).toBeUndefined();
    expect(lean.verify).toHaveBeenCalledTimes(1);
  });

  describe("the count probe of the statement check", () => {
    const refute = (theoremType: string) => countRefute({ theoremName: "rows", theoremType });

    it("a wrong number of arrangements is refuted by Lean's own count, whatever the size", async () => {
      expect(await refute(EIGHT.replace("5242", "5240"))).toEqual({ counted: 5242, stated: 5240, reps: [], kind: "rows" });
      lean.evaluate.mockResolvedValue([{ severity: "info", data: LEVELS_9 }]);
      expect(await refute(NINE.replace("47622", "40320"))).toEqual({ counted: 47622, stated: 40320, reps: [], kind: "rows" });
      expect(lean.close).toHaveBeenCalledTimes(2);
    });

    it("says nothing when the number agrees, when Lean did not count, or for another kind of statement", async () => {
      expect(await refute(EIGHT)).toBeUndefined();
      lean.evaluate.mockResolvedValue([{ severity: "error", data: "failed to synthesize Decidable" }]);
      expect(await refute(EIGHT.replace("5242", "5240"))).toBeUndefined();
      // a list of the wrong length is not a count
      lean.evaluate.mockResolvedValue([{ severity: "info", data: "[8, 42]" }]);
      expect(await refute(EIGHT.replace("5242", "5240"))).toBeUndefined();
      lean.opened.length = 0;
      expect(await refute(": (Finset.univ.filter (fun s : Finset (Fin 7) => s.card = 3)).card = 36")).toBeUndefined();
      expect(lean.opened).toHaveLength(0);
    });
  });
});
