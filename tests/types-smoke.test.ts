import { describe, it, expect } from "vitest";
import { TAXONOMY } from "@/lib/types";

describe("TAXONOMY", () => {
  it("has exactly eight categories from the spec", () => {
    expect(TAXONOMY).toEqual([
      "rewrite",
      "calc",
      "induction",
      "cases",
      "ring_or_linarith",
      "constructive",
      "contradiction",
      "other",
    ]);
  });
});
