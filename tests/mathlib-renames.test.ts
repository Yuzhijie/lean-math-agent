import { describe, expect, it } from "vitest";
import { MATHLIB_RENAMES, MATHLIB_RENAMES_VERSION, RENAMED_LEMMAS, renamedTo, renameOldLemmas } from "@/lib/lean/renamed";
import { modernizeLeanSyntax } from "@/lib/lean/modernize";

describe("renames generated from Mathlib's @[deprecated] history", () => {
  it("covers the sandbox's Mathlib and the names models still write", () => {
    expect(MATHLIB_RENAMES_VERSION).toBe("v4.33.1");
    expect(Object.keys(MATHLIB_RENAMES).length).toBeGreaterThan(10_000);
    expect(renamedTo("le_div_iff")).toBe("le_div_iff₀");
    expect(renamedTo("Finset.not_mem_empty")).toBe("Finset.notMem_empty");
    expect(renamedTo("Set.mem_setOf_eq")).toBe("Set.mem_ofPred_eq");
    expect(renamedTo("pow_lt_pow")).toBe("pow_lt_pow_right₀");
    // short plain words are left alone (more often a variable than the old lemma)
    expect(MATHLIB_RENAMES.lo).toBeUndefined();
    expect(renamedTo("sub_nonneg")).toBeUndefined();
  });

  it("never disagrees with the hand table, which wins", () => {
    for (const [old, now] of Object.entries(RENAMED_LEMMAS)) {
      if (Object.hasOwn(MATHLIB_RENAMES, old)) expect(MATHLIB_RENAMES[old]).toBe(now);
      expect(renamedTo(old)).toBe(now);
    }
  });

  it("rewrites whole identifiers only", () => {
    const proof = "rw [Finset.not_mem_empty, le_div_iff hs] at h\nexact (Finset.card_insert_of_not_mem hx).trans h.le_div_iff";
    expect(renameOldLemmas(proof)).toBe("rw [Finset.notMem_empty, le_div_iff₀ hs] at h\nexact (Finset.card_insert_of_notMem hx).trans h.le_div_iff");
    // a longer name that starts with an old one, a name with a subscript, a local hypothesis
    expect(renameOldLemmas("le_div_iff_mul_le le_div_iff₀ hle_div_iff")).toBe("le_div_iff_mul_le le_div_iff₀ hle_div_iff");
    // hand-listed Real lemmas also bare (open Real); hint-only entries never
    expect(renameOldLemmas("rw [sqrt_eq_iff_sq_eq]")).toBe("rw [sqrt_eq_iff_eq_sq]");
    expect(renameOldLemmas("exact abs_le_abs_of_sq_le_sq h")).toBe("exact abs_le_abs_of_sq_le_sq h");
  });

  it("is applied to model proofs before verification", () => {
    expect(modernizeLeanSyntax("simp [Finset.not_mem_empty]")).toContain("Finset.notMem_empty");
  });
});
