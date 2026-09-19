import { describe, it, expect } from "vitest";
import {
  sanitizeLeanSource,
  sanitizeLeanBody,
  splitHeader,
  stripCommentsAndStrings,
  validateTheoremStatement,
} from "@/lib/lean/sanitize";
import {
  classifyAxioms,
  normalizeSignature,
  parseAxiomsMessage,
  parseCheckMessage,
} from "@/lib/lean/axioms";

describe("stripCommentsAndStrings", () => {
  it("removes line comments, nested block comments and strings", () => {
    const src = `theorem t : True := by -- #eval here\n  /- outer /- inner #eval -/ still -/ trivial\n  exact "#eval in string"`;
    const out = stripCommentsAndStrings(src);
    expect(out).not.toContain("#eval");
    expect(out.split("\n")).toHaveLength(3);
    expect(out).toContain("trivial");
  });
});

describe("splitHeader", () => {
  it("separates leading comments and imports from the body", () => {
    const src = "-- generated\nimport Mathlib\nimport Aesop\n\ntheorem t : True := trivial";
    const h = splitHeader(src);
    expect(h.imports).toEqual(["Mathlib", "Aesop"]);
    expect(h.headerLines).toBe(4);
    expect(h.body).toBe("theorem t : True := trivial");
  });

  it("treats a file without imports as all body", () => {
    const h = splitHeader("theorem t : True := trivial");
    expect(h.imports).toEqual([]);
    expect(h.headerLines).toBe(0);
  });
});

describe("sanitizeLeanSource", () => {
  const ok = [
    "import Mathlib\n\ntheorem t (n : ℕ) : n + 0 = n := by\n  simp",
    "theorem t : True := by\n  -- #eval is only mentioned in a comment\n  trivial",
    "theorem t (n : ℕ) : n + 0 = n := by\n  have h : n + 0 = n := Nat.add_zero n\n  exact h",
    "open Nat in\ntheorem t (n : ℕ) : n + 0 = n := by omega",
    "theorem t : True := by\n  set_option maxHeartbeats 400000 in\n  trivial",
    "theorem t (l : List ℕ) : l.length ≥ 0 := by\n  exact Nat.zero_le _\n-- uses unsafeCast? no: identifier below is fine\ntheorem u : Lean.unsafeCast = Lean.unsafeCast := rfl",
    "@[simp] theorem t : True := trivial",
  ];
  for (const src of ok) {
    it(`accepts ${JSON.stringify(src.slice(0, 40))}…`, () => {
      expect(sanitizeLeanSource(src)).toEqual({ ok: true });
    });
  }

  const bad: Array<[string, string]> = [
    ["theorem t : True := by\n  trivial\n#eval IO.println \"hi\"", "#eval"],
    ["theorem t : True := trivial\n#exit", "#exit"],
    ["run_cmd Lean.logInfo \"x\"\ntheorem t : True := trivial", "run_cmd"],
    ["theorem t : True := by\n  run_tac Lean.Elab.Tactic.evalTactic (← `(tactic| trivial))", "run_tac"],
    ["elab \"boom\" : tactic => do\n  IO.println \"x\"\ntheorem t : True := by boom", "elab"],
    ["macro_rules | `(tactic| trivial) => `(tactic| sorry)\ntheorem t : True := by trivial", "macro_rules"],
    ["axiom cheat : ∀ n : Nat, n + 0 = n\ntheorem t (n : Nat) : n + 0 = n := cheat n", "axiom"],
    ["unsafe def f : Nat := 0\ntheorem t : True := trivial", "unsafe"],
    ["@[implemented_by f] def g : Nat := 0\ntheorem t : True := trivial", "@[implemented_by]"],
    ["@[extern \"c_fn\"] def g : Nat → Nat := id\ntheorem t : True := trivial", "@[extern]"],
    ["attribute [extern \"x\"] g\ntheorem t : True := trivial", "attribute [extern]"],
    ["initialize foo : IO.Ref Nat ← IO.mkRef 0\ntheorem t : True := trivial", "initialize"],
    ["theorem t : True := trivial\nimport Mathlib", "import"],
    ["set_option maxHeartbeats 0 in\ntheorem t : True := trivial", "set_option maxHeartbeats 0"],
    ["theorem t : True := by\n  syntax \"foo\" : tactic\n  trivial", "syntax"],
  ];
  for (const [src, token] of bad) {
    it(`rejects ${token}`, () => {
      const r = sanitizeLeanSource(src);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.matches).toContain(token);
    });
  }

  it("rejects oversized sources", () => {
    const r = sanitizeLeanBody("theorem t : True := trivial\n" + "-- x\n".repeat(60_000));
    // body-only check has no size limit; full check does
    expect(r.ok).toBe(true);
    expect(sanitizeLeanSource("-- x\n".repeat(60_000)).ok).toBe(false);
  });
});

describe("validateTheoremStatement", () => {
  it("accepts ordinary statements", () => {
    expect(validateTheoremStatement("problem", ": ∀ (n : ℕ), n + 0 = n")).toEqual({ ok: true });
    expect(validateTheoremStatement("Nat.my_lemma", "(n m : ℕ) : n + m = m + n")).toEqual({ ok: true });
    expect(validateTheoremStatement("t", "{α : Type} [Group α] (a : α) : a * 1 = a")).toEqual({ ok: true });
  });

  it("rejects statements that could close or escape the declaration", () => {
    expect(validateTheoremStatement("t", ": True := by trivial").ok).toBe(false);
    expect(validateTheoremStatement("t", ": True\naxiom cheat : False").ok).toBe(false);
    expect(validateTheoremStatement("t", ": True -- comment").ok).toBe(false);
    expect(validateTheoremStatement("t", "∀ n, n = n").ok).toBe(false); // missing leading ':'
    expect(validateTheoremStatement("t", ": sorry").ok).toBe(false);
    expect(validateTheoremStatement("bad name", ": True").ok).toBe(false);
    expect(validateTheoremStatement("t", "").ok).toBe(false);
  });
});

describe("axioms", () => {
  it("parses #print axioms output", () => {
    expect(parseAxiomsMessage("'foo' depends on axioms: [propext, Classical.choice, Quot.sound]", "foo")).toEqual([
      "propext",
      "Classical.choice",
      "Quot.sound",
    ]);
    expect(parseAxiomsMessage("'foo' does not depend on any axioms", "foo")).toEqual([]);
    expect(parseAxiomsMessage("'bar' depends on axioms: [sorryAx]", "foo")).toBeUndefined();
    expect(parseAxiomsMessage("Nat.add_comm : ∀ (n m : ℕ), n + m = m + n", "foo")).toBeUndefined();
  });

  it("classifies sorry and native_decide axioms", () => {
    const r = classifyAxioms(["propext", "sorryAx", "t._native.native_decide.ax_1"]);
    expect(r.usesSorry).toBe(true);
    expect(r.usesNative).toBe(true);
    expect(r.disallowed).toEqual(["sorryAx", "t._native.native_decide.ax_1"]);
    expect(classifyAxioms(["propext", "Quot.sound"]).disallowed).toEqual([]);
    expect(classifyAxioms(["Lean.ofReduceBool"], { allowNative: true }).disallowed).toEqual([]);
    expect(classifyAxioms(["Lean.ofReduceBool"], { allowNative: false }).disallowed).toEqual(["Lean.ofReduceBool"]);
  });

  it("parses and normalises #check output", () => {
    expect(parseCheckMessage("foo : ∀ (n : ℕ),\n    n + 0 = n", "foo")).toBe("∀ (n : ℕ), n + 0 = n");
    expect(parseCheckMessage("'foo' depends on axioms: []", "foo")).toBeUndefined();
    expect(normalizeSignature("  ∀ (n : ℕ),\n   n + 0 =\n n ")).toBe("∀ (n : ℕ), n + 0 = n");
  });
});
