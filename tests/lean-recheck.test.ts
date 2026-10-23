import { describe, expect, it } from "vitest";
import { recheckItems, recheckReport, splitStatement } from "@/lib/pipeline/lean-recheck";
import type { Session } from "@/lib/types";

const session = (over: Partial<Session>): Session =>
  ({ id: "s", schema_version: 1, owner: "local", problem_text: "p", pipeline_stage: "complete", formal_validated: false, validation_results: [], methods: [], steps: [], assembled_lean: "", build_status: "idle", sorry_labels: [], created_at: 1, updated_at: 1, ...over }) as Session;

describe("lean re-check of stored statements", () => {
  it("splits a stored statement", () => {
    expect(splitStatement("theorem t : 1 + 1 = 2 := by sorry")).toEqual({ theoremName: "t", theoremType: ": 1 + 1 = 2" });
    expect(splitStatement("theorem t (n : ℕ) : n + 0 = n := by sorry")).toEqual({ theoremName: "t", theoremType: "(n : ℕ) : n + 0 = n" });
    expect(splitStatement("")).toBeUndefined();
  });

  it("keeps one item per problem (its latest statement), remembers an earlier success, and classifies failures", () => {
    const fail = (id: string, t: number, reason: string, lim: string[] = []) =>
      session({ id, created_at: t, problem_text: "求最小的 n", lean_proof_attempt: { attempted: true, success: false, formal_statement: `theorem a${id} : 1 = 1 := by sorry`, failure_reason: reason, limitations: lim } });
    const items = recheckItems([
      fail("1", 1, "计算问题的形式化证明需要复杂的数值推导，当前自动证明能力有限"),
      fail("2", 2, "陈述通过了检查，但这次没有找到能通过 Lean 检查的证明", ["已尝试：…", "最接近的一个证明卡在：omega could not prove the goal"]),
      session({ id: "3", created_at: 3, problem_text: "另一题", lean_proof_attempt: { attempted: true, success: true, strategy: "hammer", formal_statement: "theorem b : 2 = 2 := by sorry" } }),
      session({ id: "4", created_at: 4, problem_text: "没写陈述", lean_proof_attempt: { attempted: false, success: false } }),
      session({ id: "5", created_at: 5, problem_text: "证明题", theorem_name: "c", theorem_type: ": True", formal_signature: "True", formal_validated: true, build_status: "fail" }),
    ]);
    expect(items.map((i) => [i.sessionId, i.before, i.tries])).toEqual([
      ["2", "no_proof", 2],
      ["3", "proved", 1],
      ["5", "no_proof", 1],
    ]);
    expect(items[0].beforeDetail).toBe("omega could not prove the goal");
    expect(items[0].theoremName).toBe("a2");
    expect(items[2]).toMatchObject({ kind: "theorem", expectedSignature: "True" });
    const md = recheckReport(
      items.map((item, k) => ({ item, checked: true, ...(k === 0 ? { now: { strategy: "order", attempts: 1 } } : {}), ms: 1 })),
      { date: "2026-10-23" },
    );
    expect(md).toContain("| Not proved then, proved now without a model | 1 |");
    expect(md).toContain("| Proved (then or now) | 2 (67%) |");
    expect(md).toContain("proved (order)");
    // a statement that never passed the checks is not counted as proved
    const refuted = recheckItems([
      session({ id: "9", problem_text: "错答案", lean_proof_attempt: { attempted: true, success: false, formal_statement: "theorem z : 1 = 1 := by sorry", failure_reason: "按答案 5 写出的陈述没有通过数值检查——这个答案可能有误，请先核对答案" } }),
    ]);
    expect(refuted[0].before).toBe("no_statement");
    const md2 = recheckReport([{ item: refuted[0], checked: true, now: { strategy: "hammer", attempts: 1 }, ms: 1 }], { date: "x" });
    expect(md2).toContain("| Proved (then or now) | 0 (0%) |");
    expect(md2).toContain("provable now (not counted: the statement may be wrong) | 1 |");
  });
});
