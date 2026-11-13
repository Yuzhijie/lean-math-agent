import { describe, expect, it } from "vitest";
import { parseSpawnOutput } from "@/lib/lean/sandbox";
import { classifyAxioms, parseAxiomsMessage, parseCheckMessage } from "@/lib/lean/axioms";

// What `lake env lean Verify.lean` prints: diagnostics with a position, probe answers bare.
describe("parseSpawnOutput", () => {
  it("reads the probes' answers after a linter warning (a verified proof used to fail here)", () => {
    const out = [
      "Verify.lean:48:61: warning: This simp argument is unused:",
      "  List.all_eq_true",
      "",
      "Hint: Omit it from the simp argument list.",
      "  simp only [cH0, Adjacent, List.any_eq_true]",
      "",
      "Note: This linter can be disabled with `set_option linter.unusedSimpArgs false`",
      "Verify.lean:16:8: warning: this tactic is never executed",
      "",
      "Note: This linter can be disabled with `set_option linter.unreachableTactic false`",
      "'seating_count' depends on axioms: [propext, Classical.choice, Quot.sound]",
      "seating_count : have Adjacent := fun p x y =>",
      "  ∃ i, p i = x ∧ p (i + 1) = y ∨ p i = y ∧ p (i + 1) = x;",
      "have Valid := fun p => Function.Bijective p ∧ ¬Adjacent p 0 1;",
      "{O | ∃ p, Valid p ∧ O = Orbit p}.ncard = 1152",
      "",
    ].join("\n");
    const r = parseSpawnOutput(out, { probeName: "seating_count" });
    expect(r.messages.map((m) => m.severity)).toEqual(["warning", "warning"]);
    // the warnings keep their own continuation lines and nothing of the probes
    expect(r.messages[0].message).toContain("Hint: Omit it");
    expect(r.messages[1].message).toContain("linter.unreachableTactic");
    expect(r.messages[1].message).not.toContain("depends on axioms");
    expect(r.infos).toHaveLength(2);
    expect(classifyAxioms(parseAxiomsMessage(r.infos[0], "seating_count")!).disallowed).toEqual([]);
    // the whole signature, its unindented lines included
    expect(parseCheckMessage(r.infos[1], "seating_count")).toContain("have Valid := fun p => Function.Bijective p ∧ ¬Adjacent p 0 1;");
    expect(parseCheckMessage(r.infos[1], "seating_count")).toContain("ncard = 1152");
  });

  it("an error after the probes' answers is still an error", () => {
    const out = ["'t' does not depend on any axioms", "t : ∀ (n : ℕ),", "  n + 0 = n", "Verify.lean:9:2: error: unsolved goals", "n : ℕ", "⊢ n + 0 = n"].join("\n");
    const r = parseSpawnOutput(out, { probeName: "t" });
    expect(parseAxiomsMessage(r.infos[0], "t")).toEqual([]);
    expect(r.infos[1]).toBe("t : ∀ (n : ℕ),\n  n + 0 = n");
    expect(r.messages).toEqual([{ severity: "error", line: 9, column: 2, message: "unsolved goals\nn : ℕ\n⊢ n + 0 = n" }]);
  });

  it("sorry warnings, positions after the prelude, another declaration's name is not a probe answer", () => {
    const out = ["Verify.lean:7:8: warning: declaration uses `sorry`", "other : True", "Verify.lean:3:0: info: hello"].join("\n");
    const r = parseSpawnOutput(out, { bodyStartLine: 5, probeName: "t" });
    expect(r.sorryWarning).toBe(true);
    expect(r.sorries).toHaveLength(1);
    // "other : True" is not this theorem's `#check`: it stays with the warning it follows
    expect(r.messages[0].message).toContain("other : True");
    expect(r.messages[0].line).toBeLessThan(7);
    expect(r.infos).toEqual(["hello"]);
  });
});
