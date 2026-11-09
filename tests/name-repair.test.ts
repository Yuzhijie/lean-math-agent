import { describe, expect, it } from "vitest";
import { nameVariants, repairUnknownNames } from "@/lib/lean/name-repair";

describe("unknown-name repair", () => {
  it("proposes Mathlib's systematic renames, all of them at once first", () => {
    expect(nameVariants("Finset.card_insert_of_not_mem")).toEqual(["Finset.card_insert_of_notMem"]);
    expect(nameVariants("Nat.cast_le_nat_cast_iff")[0]).toBe("Nat.cast_le_natCast_iff₀");
    expect(nameVariants("lt_div_iff'")).toContain("lt_div_iff₀'");
    expect(nameVariants("sq_nonneg")).toEqual([]);
  });

  it("uses the rename tables first and replaces whole identifiers only", async () => {
    const r = await repairUnknownNames("rw [le_div_iff hs]\nexact h.le_div_iff", ["le_div_iff"]);
    expect(r?.tactics).toBe("rw [le_div_iff₀ hs]\nexact h.le_div_iff");
    expect(r?.replaced).toEqual([["le_div_iff", "le_div_iff₀"]]);
    expect(await repairUnknownNames("exact foo", ["foo"])).toBeUndefined();
  });
});
