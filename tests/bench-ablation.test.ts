import { describe, expect, it } from "vitest";
import { renderAblation, sampleTheorems, VARIANTS } from "@/scripts/bench-ablation";

const T = (n: number, d: string) => Array.from({ length: n }, (_, i) => ({ id: `${d}_${String(i).padStart(3, "0")}`, difficulty: d }));

describe("bench:ablation", () => {
  it("samples the same theorems every time, in proportion to difficulty", () => {
    const all = [...T(110, "easy"), ...T(78, "medium"), ...T(56, "hard")];
    const a = sampleTheorems(all, 60);
    expect(a.map((t) => t.id)).toEqual(sampleTheorems([...all].reverse(), 60).map((t) => t.id));
    const count = (d: string) => a.filter((t) => t.difficulty === d).length;
    expect([count("easy"), count("medium"), count("hard")]).toEqual([27, 19, 14]);
    expect(sampleTheorems(all.slice(0, 5), 60)).toHaveLength(5);
  });

  it("reports proofs, cost and marginal proofs per dollar against the base run", () => {
    const row = (id: string, ok: boolean, cost: number, proved_by = "whole_proof") => ({ id, difficulty: "easy", ok, proved_by: ok ? proved_by : "none", cost, wall_ms: 60_000 });
    const base = { started_at: "", rows: [row("a", true, 0, "hammer"), row("b", true, 0.01), row("c", false, 0.03), row("d", false, 0.03)] };
    const normal = { started_at: "", rows: [row("a", true, 0, "hammer"), row("b", true, 0.02), row("c", true, 0.05), row("d", false, 0.09)] };
    const noRet = { started_at: "", rows: [row("a", true, 0, "hammer"), row("b", false, 0.01), row("c", false, 0.03), row("d", false, 0.03)] };
    const md = renderAblation([{ name: "base", result: base }, { name: "normal", result: normal }, { name: "no_retrieval", result: noRet }]);
    expect(md).toContain("| base | cascade, low budget | 2/4 | $0.07 | $0.04 | 4.0 min | — | — |");
    expect(md).toContain("| normal | normal budget | 3/4 | $0.16 | $0.05 | 4.0 min | +1 / −0 | 11.1 per $ (+1 for +$0.09) |");
    expect(md).toContain("| no_retrieval | no premise retrieval | 1/4 | $0.07 | $0.07 | 4.0 min | +0 / −1 | -1 at no cost |");
    expect(md).toContain("the hammer proved 1 of 2 theorems");
    expect(Object.keys(VARIANTS)).toEqual(expect.arrayContaining(["base", "no_retrieval", "whole_proof", "early_stop", "sketch", "normal"]));
  });
});
