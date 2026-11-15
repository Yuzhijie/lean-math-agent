import { describe, expect, it } from "vitest";
import { F_TACTICS, boardsAfter, findMoves, invariantFault, parityBounds, processEvalCommand, processScript, processShape, readProcessData, type ProcessData } from "@/lib/lean/optimize/process";
import { looksOptimization } from "@/lib/lean/optimize";

// "1, …, 15 on the board; erase two numbers, write their difference; the largest last number" — the
// statement a session wrote, which every route had failed on (the bound is an invariant, not a search)
const statement = (T: string, init: string, f: string, goal: string) =>
  `: let initial : Multiset ${T} := ${init}; let step : Multiset ${T} → Multiset ${T} → Prop := fun s t => ∃ a b : ${T}, a ∈ s ∧ b ∈ s.erase a ∧ t = (s.erase a).erase b + ({${f}} : Multiset ${T}); let reach : Multiset ${T} → Multiset ${T} → Prop := Relation.ReflTransGen step; ${goal}`;
const BOARD = statement("ℤ", "(Multiset.range 15).map (fun n : ℕ => (n : ℤ) + 1)", "((Int.natAbs (a - b) : ℕ) : ℤ)", "IsGreatest {z : ℤ | reach initial ({z} : Multiset ℤ)} 14");

/** |a − b| on 1 … n, as Lean would list it. */
const oneTo = (n: number): ProcessData => ({
  start: Array.from({ length: n }, (_, i) => i + 1),
  table: Array.from({ length: n + 1 }, (_, a) => Array.from({ length: n + 1 }, (_, b) => Math.abs(a - b))),
});

describe("replacement processes: the statement", () => {
  it("reads the session's statement", () => {
    expect(looksOptimization(BOARD)).toBe(true);
    expect(processShape(BOARD)).toMatchObject({
      names: ["initial", "step", "reach"],
      type: "ℤ",
      initial: "initial",
      step: "step",
      reach: "reach",
      a: "a",
      b: "b",
      f: "((Int.natAbs (a - b) : ℕ) : ℤ)",
      kind: "greatest",
      M: 14,
    });
  });

  it("reads ℕ, IsLeast, other spellings of the number written, the set left without its type", () => {
    const s = processShape(statement("ℕ", "Multiset.Icc 1 12", "Nat.dist a b", "IsLeast {z : ℕ | reach initial {z}} 0"))!;
    expect(s).toMatchObject({ type: "ℕ", f: "Nat.dist a b", kind: "least", M: 0 });
    expect(processShape(statement("ℤ", "({3, 5, 9} : Multiset ℤ)", "|a - b|", "IsGreatest {z | reach initial ({z} : Multiset ℤ)} (9 : ℤ)"))).toMatchObject({ f: "|a - b|", M: 9 });
    expect(processShape(statement("ℕ", "Multiset.Icc 1 8", "if a ≤ b then b - a else a - b", "IsLeast {z : ℕ | reach initial ({z} : Multiset ℕ)} 0"))?.f).toBe("if a ≤ b then b - a else a - b");
    // other names
    const renamed = BOARD.replaceAll("initial", "board").replaceAll("step", "move").replaceAll("reach", "leadsTo").replace("fun s t => ∃ a b", "fun u v => ∃ x y").replace("a ∈ s ∧ b ∈ s.erase a ∧ t = (s.erase a).erase b", "x ∈ u ∧ y ∈ u.erase x ∧ v = (u.erase x).erase y").replace("(a - b)", "(x - y)");
    expect(processShape(renamed)).toMatchObject({ names: ["board", "move", "leadsTo"], a: "x", b: "y", f: "((Int.natAbs (x - y) : ℕ) : ℤ)" });
  });

  it("leaves other statements alone", () => {
    // two numbers written, not one
    expect(processShape(BOARD.replace("({((Int.natAbs (a - b) : ℕ) : ℤ)} : Multiset ℤ)", "({a + b, a - b} : Multiset ℤ)"))).toBeUndefined();
    // not erasing both
    expect(processShape(BOARD.replace("(s.erase a).erase b +", "s.erase a +"))).toBeUndefined();
    // a board that is no multiset
    expect(processShape(BOARD.replace("let initial : Multiset ℤ := (Multiset.range 15).map (fun n : ℕ => (n : ℤ) + 1)", "let initial : Finset ℤ := Finset.Icc 1 15"))).toBeUndefined();
    // not the last number
    expect(processShape(BOARD.replace("IsGreatest {z : ℤ | reach initial ({z} : Multiset ℤ)} 14", "∀ t, reach initial t → t.card ≤ 15"))).toBeUndefined();
    // a let, or one of the two numbers, that carries one of the proof's own names — x, z, t are not among them
    expect(processShape(BOARD.replaceAll("reach", "hinv"))).toBeUndefined();
    expect(processShape(BOARD.replace("∃ a b : ℤ, a ∈ s ∧ b ∈ s.erase a ∧ t = (s.erase a).erase b", "∃ h b : ℤ, h ∈ s ∧ b ∈ s.erase h ∧ t = (s.erase h).erase b").replace("(a - b)", "(h - b)"))).toBeUndefined();
    expect(processShape(BOARD.replaceAll("reach", "m3"))).toBeUndefined(); // the moves are m1, m2, …
    expect(processShape(": IsGreatest {t : ℕ | ∃ a b : ℕ, a + b = 10 ∧ t = a * b} 25")).toBeUndefined();
  });
});

describe("replacement processes: what Lean lists", () => {
  it("asks for the numbers at the start and the table of the number written, with the statement's own text", () => {
    const cmd = processEvalCommand(processShape(BOARD)!);
    expect(cmd).toContain("abbrev initial : Multiset ℤ := (Multiset.range 15).map (fun n : ℕ => (n : ℤ) + 1)");
    expect(cmd).toContain("let l := (initial).sort (· ≤ ·)");
    expect(cmd).toContain("(fun (a b : ℤ) => (((Int.natAbs (a - b) : ℕ) : ℤ) : ℤ)) (i : ℤ) (j : ℤ)");
    expect(cmd).not.toMatch(/abbrev (step|reach)/); // only the board is computed
    // a board written with another let: that let is defined first
    const viaN = processEvalCommand(processShape(BOARD.replace(": let initial : Multiset ℤ := (Multiset.range 15)", ": let n : ℕ := 15; let initial : Multiset ℤ := (Multiset.range n)"))!);
    expect(viaN.indexOf("abbrev n : ℕ := 15")).toBeGreaterThan(0);
    expect(viaN.indexOf("abbrev n : ℕ := 15")).toBeLessThan(viaN.indexOf("abbrev initial : Multiset ℤ := (Multiset.range n)"));
    const nat = processEvalCommand(processShape(statement("ℕ", "Multiset.Icc 1 12", "Nat.dist a b", "IsLeast {z : ℕ | reach initial {z}} 0"))!);
    expect(nat).toContain("(fun (a b : ℕ) => (Nat.dist a b : ℕ)) i j");
  });

  it("reads the answer, and nothing else", () => {
    expect(readProcessData("([1, 2, 3],\n  [[0, 1, 2, 3], [1, 0, 1, 2],\n    [2, 1, 0, 1], [3, 2, 1, 0]])")).toEqual({ start: [1, 2, 3], table: [[0, 1, 2, 3], [1, 0, 1, 2], [2, 1, 0, 1], [3, 2, 1, 0]] });
    expect(readProcessData("([-1, 2], [[0]])")).toEqual({ start: [-1, 2], table: [[0]] });
    expect(readProcessData("([1, 2], [[0, 1], [1]])")).toBeUndefined(); // not square
    expect(readProcessData("unknown identifier 'initial'")).toBeUndefined();
    expect(readProcessData('([1], [[0]]); process.exit(1)')).toBeUndefined();
  });
});

describe("replacement processes: the invariant and the moves", () => {
  it("range and parity: 1 … 15 leaves at most 14, at least 0; 1 … 5 between 1 and 5", () => {
    expect(parityBounds(oneTo(15))).toEqual({ hi: 15, parity: 0, greatest: 14, least: 0 });
    expect(parityBounds(oneTo(5))).toEqual({ hi: 5, parity: 1, greatest: 5, least: 1 });
    expect(parityBounds(oneTo(10))).toMatchObject({ parity: 1, greatest: 9, least: 1 });
    expect(invariantFault(oneTo(15))).toBeUndefined();
  });

  it("says why the invariant does not fit another process", () => {
    const sum: ProcessData = { start: [1, 2, 3], table: Array.from({ length: 4 }, (_, a) => Array.from({ length: 4 }, (_, b) => a + b)) };
    expect(invariantFault(sum)).toMatch(/leaves the range 0 … 3/);
    const half: ProcessData = { start: [2, 4], table: Array.from({ length: 5 }, (_, a) => Array.from({ length: 5 }, (_, b) => Math.floor((a + b) / 2))) };
    expect(invariantFault(half)).toMatch(/changes the parity of the sum/);
    expect(invariantFault({ start: [-1, 2], table: [[0]] })).toMatch(/negative/);
    expect(invariantFault({ start: [1, 99], table: [[0]] })).toMatch(/above 60/);
    expect(invariantFault({ start: [], table: [[0]] })).toMatch(/no numbers/);
  });

  it("finds the moves that leave 14 from 1 … 15: 14 kept aside, the others down to 0", () => {
    const data = oneTo(15);
    const moves = findMoves(data, 14)!;
    expect(moves).toHaveLength(14);
    expect(moves[0]).toEqual([15, 13]);
    expect(moves[moves.length - 1]).toEqual([14, 0]);
    const boards = boardsAfter(data, moves)!;
    expect(boards[0]).toEqual([1, 2, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14]);
    expect(boards[boards.length - 1]).toEqual([14]);
  });

  it("finds the smallest too, and the values of every start 1 … n up to 20", () => {
    for (let n = 2; n <= 20; n++) {
      const data = oneTo(n);
      const { greatest, least } = parityBounds(data);
      for (const target of [greatest, least]) {
        const moves = findMoves(data, target);
        expect(moves, `1 … ${n} → ${target}`).toBeDefined();
        expect(boardsAfter(data, moves!)!.pop(), `1 … ${n} → ${target}`).toEqual([target]);
      }
    }
  });

  it("searches when keeping the target aside is not enough, and gives up on what cannot be left", () => {
    // 3 is not on the board: 8 − 5 = 3, then 3 − (2 − 2) …
    const data: ProcessData = { start: [2, 2, 5, 8], table: oneTo(8).table };
    const moves = findMoves(data, 3)!;
    expect(boardsAfter(data, moves)!.pop()).toEqual([3]);
    // parity: 15 can never be left from 1 … 15; a board of one number is what it is
    expect(findMoves(oneTo(15), 15, 20_000)).toBeUndefined();
    expect(findMoves({ start: [4], table: oneTo(4).table }, 4)).toEqual([]);
    expect(findMoves({ start: [4], table: oneTo(4).table }, 2)).toBeUndefined();
    // moves that do not fit the board
    expect(boardsAfter(oneTo(3), [[5, 1]])).toBeUndefined();
  });
});

describe("replacement processes: the proof", () => {
  const shape = processShape(BOARD)!;
  const data = oneTo(15);
  const moves = findMoves(data, 14)!;
  const sc = processScript(shape, data, moves)!;

  it("states the two facts about the number written once, with the statement's own text", () => {
    expect(sc.startsWith("intro initial step reach")).toBe(true);
    expect(sc).toContain("have hF : ∀ a b : ℤ, 0 ≤ a → a ≤ 15 → 0 ≤ b → b ≤ 15 → 0 ≤ (((Int.natAbs (a - b) : ℕ) : ℤ) : ℤ) ∧ (((Int.natAbs (a - b) : ℕ) : ℤ) : ℤ) ≤ 15 ∧ ((((Int.natAbs (a - b) : ℕ) : ℤ) : ℤ) + a + b) % 2 = 0 := by\n  intro a b h1 h2 h3 h4\n  omega");
    // one tactic per script: the others are whole scripts of their own (no `first` with branches that never run)
    expect(sc).not.toContain("first");
    const tactics = F_TACTICS("a", "b");
    expect(tactics[0]).toBe("omega");
    expect(processScript(shape, data, moves, tactics[1])).toContain("intro a b h1 h2 h3 h4\n  simp only [Nat.dist]; omega");
    // the way that fits the spelling is tried first, the others after it; every pair of the range last
    expect(F_TACTICS("a", "b", "((Int.natAbs (a - b) : ℕ) : ℤ)")[0]).toBe("omega");
    expect(F_TACTICS("a", "b", "Nat.dist a b")[0]).toBe("simp only [Nat.dist]; omega");
    expect(F_TACTICS("a", "b", "if a ≤ b then b - a else a - b")[0]).toBe("split_ifs <;> omega");
    expect(F_TACTICS("a", "b", "max a b - min a b")[0]).toBe("simp only [max_def, min_def]; split_ifs <;> omega");
    expect(F_TACTICS("p", "q", "|p - q|")[0]).toBe("rcases abs_cases (p - q) with ⟨h, _⟩ | ⟨h, _⟩ <;> rw [h] <;> omega");
    for (const f of ["Nat.dist a b", "|a - b|", "a - b"]) {
      const ways = F_TACTICS("a", "b", f);
      expect([...ways].sort()).toEqual([...tactics].sort());
      expect(ways[ways.length - 1]).toBe("interval_cases a <;> interval_cases b <;> decide");
    }
  });

  it("carries range and parity along the process by induction", () => {
    expect(sc).toContain("have hinv : ∀ t_, Relation.ReflTransGen step initial t_ → (∀ e_ ∈ t_, 0 ≤ e_ ∧ e_ ≤ 15) ∧ t_.sum % 2 = 0 := by");
    expect(sc).toContain("  induction ht with\n  | refl => exact ⟨by decide, by decide⟩\n  | tail _ hst ih =>");
    expect(sc).toContain("generalize (((Int.natAbs (a - b) : ℕ) : ℤ) : ℤ) = f_ at hf0 hf1 hf2 ⊢");
    expect(sc).toContain("have h1 := Multiset.sum_erase ha");
  });

  it("reaches 14 by one decided step per move and bounds the last number by the invariant", () => {
    expect(sc).toContain("· show Relation.ReflTransGen step initial ({14} : Multiset ℤ)");
    expect(sc).toContain("have m1 : step initial ((([1, 2, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14] : List ℤ)) : Multiset ℤ) := ⟨15, 13, by decide, by decide, by decide⟩");
    expect(sc).toContain("have m14 : step ((([0, 14] : List ℤ)) : Multiset ℤ) ({14} : Multiset ℤ) := ⟨14, 0, by decide, by decide, by decide⟩");
    expect((sc.match(/Relation\.ReflTransGen\.head m\d+ \(/g) ?? []).length).toBe(14);
    expect(sc).toContain("· intro z_ hz\n  obtain ⟨hb0, hs0⟩ := hinv {z_} hz");
    expect(sc.trimEnd().endsWith("show z_ ≤ 14\n  omega")).toBe(true);
  });

  it("the smallest: the same invariant, the bound the other way; odd sums keep parity 1", () => {
    const least = processShape(BOARD.replace("IsGreatest", "IsLeast").replace("} 14", "} 0"))!;
    const s0 = processScript(least, data, findMoves(data, 0)!)!;
    expect(s0.trimEnd().endsWith("show 0 ≤ z_\n  omega")).toBe(true);
    const five = oneTo(5);
    const odd = processShape(statement("ℕ", "Multiset.Icc 1 5", "Nat.dist a b", "IsGreatest {z : ℕ | reach initial {z}} 5"))!;
    const s5 = processScript(odd, five, findMoves(five, 5)!)!;
    expect(s5).toContain("(∀ e_ ∈ t_, 0 ≤ e_ ∧ e_ ≤ 5) ∧ t_.sum % 2 = 1");
    expect(s5).toContain("({5} : Multiset ℕ)");
  });

  it("writes nothing when the moves do not end at the statement's value", () => {
    expect(processScript(shape, data, findMoves(data, 0)!)).toBeUndefined();
    expect(processScript(shape, data, [])).toBeUndefined();
  });
});
