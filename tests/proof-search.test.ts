import { describe, it, expect } from "vitest";
import { PriorityQueue } from "@/lib/search/priority-queue";
import { labelSorry, sorryReport } from "@/lib/lean/sorry-gate";
import type { ProofStep, ClassifiedError, SorryLabel } from "@/lib/types";

describe("PriorityQueue", () => {
  it("returns items in priority order (min-heap)", () => {
    const pq = new PriorityQueue<number>((a, b) => a - b);
    pq.push(5);
    pq.push(1);
    pq.push(3);
    pq.push(2);
    pq.push(4);

    expect(pq.pop()).toBe(1);
    expect(pq.pop()).toBe(2);
    expect(pq.pop()).toBe(3);
    expect(pq.pop()).toBe(4);
    expect(pq.pop()).toBe(5);
  });

  it("handles single element", () => {
    const pq = new PriorityQueue<number>((a, b) => a - b);
    pq.push(42);
    expect(pq.size).toBe(1);
    expect(pq.pop()).toBe(42);
    expect(pq.size).toBe(0);
  });

  it("returns undefined for empty pop", () => {
    const pq = new PriorityQueue<number>((a, b) => a - b);
    expect(pq.pop()).toBeUndefined();
  });

  it("peek does not remove element", () => {
    const pq = new PriorityQueue<number>((a, b) => a - b);
    pq.push(3);
    pq.push(1);
    expect(pq.peek()).toBe(1);
    expect(pq.size).toBe(2);
  });

  it("works with custom comparator (objects)", () => {
    interface Item { score: number; name: string }
    const pq = new PriorityQueue<Item>((a, b) => a.score - b.score);
    pq.push({ score: 10, name: "low-priority" });
    pq.push({ score: 1, name: "high-priority" });
    pq.push({ score: 5, name: "mid-priority" });

    expect(pq.pop()?.name).toBe("high-priority");
    expect(pq.pop()?.name).toBe("mid-priority");
    expect(pq.pop()?.name).toBe("low-priority");
  });
});

describe("sorry-gate", () => {
  const makeStep = (index: number): ProofStep => ({
    index,
    plain_goal: `prove step ${index}`,
    lean_goal: `⊢ P${index}`,
    plain_explanation: "",
    lean_code: "",
    status: "fail",
  });

  describe("labelSorry", () => {
    it("creates label from classified errors", () => {
      const step = makeStep(2);
      const errors: ClassifiedError[] = [
        {
          kind: "type_mismatch",
          line: 5,
          message: "expected Nat but got Int",
          suggestion: "add coercion",
          raw: "error: type mismatch",
        },
      ];

      const label = labelSorry(step, errors);
      expect(label.step_index).toBe(2);
      expect(label.reason).toContain("type_mismatch");
      expect(label.lean_goal).toBe("⊢ P2");
      expect(label.suggested_approach).toBe("add coercion");
    });

    it("creates label without errors (fallback)", () => {
      const step = makeStep(0);
      const label = labelSorry(step);
      expect(label.step_index).toBe(0);
      expect(label.reason).toContain("证明生成或编译失败");
    });
  });

  describe("sorryReport", () => {
    it("reports fully verified when no sorry", () => {
      const report = sorryReport([]);
      expect(report.fully_verified).toBe(true);
      expect(report.summary).toContain("✅");
    });

    it("reports sorry count when present", () => {
      const labels: SorryLabel[] = [
        {
          step_index: 1,
          reason: "type mismatch",
          lean_goal: "⊢ P1",
          suggested_approach: "add coercion",
        },
        {
          step_index: 3,
          reason: "timeout",
          lean_goal: "⊢ P3",
          suggested_approach: "simplify",
        },
      ];

      const report = sorryReport(labels);
      expect(report.fully_verified).toBe(false);
      expect(report.summary).toContain("2");
      expect(report.details).toHaveLength(2);
    });
  });
});
