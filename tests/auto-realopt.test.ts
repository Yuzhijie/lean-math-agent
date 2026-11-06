import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { extremumScripts, readExtremumGoal } from "@/lib/lean/auto/realopt";
import { parseGoal } from "@/lib/lean/geometry/goal";

const hasSympy = spawnSync(process.env.GEOMETRY_PYTHON ?? "python3", ["-c", "import sympy"]).status === 0;

describe("real extremum statements", () => {
  it("reads IsLeast / IsGreatest of a set of values", () => {
    expect(readExtremumGoal("IsLeast {t | ∃ x y z, x + y + z = 3 ∧ x ^ 2 + y ^ 2 + z ^ 2 = 9 ∧ t = x * y * z} (-4)")).toEqual({
      kind: "min",
      setVar: "t",
      vars: ["x", "y", "z"],
      conjuncts: ["x + y + z = 3", "x ^ 2 + y ^ 2 + z ^ 2 = 9", "t = x * y * z"],
      valueAt: 2,
      target: "x * y * z",
      value: "-4",
    });
    expect(readExtremumGoal("IsGreatest {p | ∃ a b, a + b = 2 ∧ a * b = p} 1")).toMatchObject({ kind: "max", vars: ["a", "b"], target: "a * b", value: "1" });
    expect(readExtremumGoal("IsLeast {t | ∃ a b c d, a = t} 0")).toBeUndefined();
  });

  it.skipIf(!hasSympy)("witness, reduction to one variable, its range and the factored bound", async () => {
    const [script] = await extremumScripts(parseGoal("⊢ IsLeast {t | ∃ x y z, x + y + z = 3 ∧ x ^ 2 + y ^ 2 + z ^ 2 = 9 ∧ t = x * y * z} (-4)")!);
    expect(script).toContain("refine ⟨⟨(-1), 2, 2, by norm_num⟩, ?_⟩");
    expect(script).toContain("rintro t ⟨x, y, z, hro1, hro2, rfl⟩");
    expect(script).toContain("have hroE : x * y * z = x ^ 3 - 3 * x ^ 2 := by linear_combination");
    expect(script).toContain("have hroL : (-1) ≤ x");
    expect(script).toContain("mul_nonneg ((by linarith : (0:ℝ) ≤ x + 1)) (sq_nonneg (x - 2))");
  }, 60_000);

  it.skipIf(!hasSympy)("no script when the value is not reached", async () => {
    expect(await extremumScripts(parseGoal("⊢ IsLeast {t | ∃ x y z, x + y + z = 3 ∧ x ^ 2 + y ^ 2 + z ^ 2 = 9 ∧ t = x * y * z} (-5)")!)).toEqual([]);
  }, 60_000);
});
