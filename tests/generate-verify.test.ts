import { beforeEach, describe, expect, it, vi } from "vitest";

const { chatMock, formalizeMock, proveMock } = vi.hoisted(() => ({ chatMock: vi.fn(), formalizeMock: vi.fn(), proveMock: vi.fn() }));
vi.mock("@/lib/llm/client", async (orig) => ({ ...(await orig<typeof import("@/lib/llm/client")>()), chatJson: chatMock }));
vi.mock("@/lib/llm/autoformalize", () => ({ autoformalize: formalizeMock }));
vi.mock("@/lib/pipeline/lean-attempt", async (orig) => ({
  ...(await orig<typeof import("@/lib/pipeline/lean-attempt")>()),
  proveWithoutModel: proveMock,
}));

import { generateProblems } from "@/lib/llm/generate-problem";
import { isProofProblem } from "@/lib/llm/verify-generated";

const base = {
  hints: ["h"],
  grade_level: "high",
  difficulty: "standard",
  domain: "algebra",
  suggested_techniques: ["direct"],
  source_inspiration: "x",
  estimated_solve_time: "5 min",
};

/** problems the writer returns, round by round */
let rounds: Array<Array<{ statement: string; answer: string }>> = [];
/** what the independent solver says per statement */
let solver: Record<string, { well_posed?: boolean; answer?: string; claim_holds?: boolean | null; issue?: string }> = {};
let writerPrompts: string[] = [];

beforeEach(() => {
  rounds = [];
  solver = {};
  writerPrompts = [];
  chatMock.mockReset();
  formalizeMock.mockReset();
  proveMock.mockReset();
  chatMock.mockImplementation(async (req: { schemaName: string; user: string }) => {
    if (req.schemaName === "generateProblemResponse") {
      writerPrompts.push(req.user);
      return { problems: (rounds.shift() ?? []).map((p) => ({ ...base, ...p })) };
    }
    if (req.schemaName === "independent_solve") {
      const s = solver[req.user] ?? {};
      return { well_posed: s.well_posed ?? true, issue: s.issue ?? null, answer: s.answer ?? "", claim_holds: s.claim_holds ?? null };
    }
    if (req.schemaName === "same_answer") return { same: false, reason: "" };
    throw new Error(`unexpected ${req.schemaName}`);
  });
  formalizeMock.mockResolvedValue({
    theorem_name: "t",
    theorem_type: ": (2 : ℕ) + 2 = 4",
    domain: "algebra",
    formal_statement: "theorem t : (2 : ℕ) + 2 = 4 := by sorry",
    formal_signature: "t : 2 + 2 = 4",
    validation_results: [
      { layer: 1, pass: true, detail: "" },
      { layer: 6, pass: true, detail: "", skipped: true },
    ],
    accepted: true,
    refutation: { verdict: "inconclusive" },
  });
  proveMock.mockResolvedValue({ tried: [] });
});

const opts = { gradeLevel: "high", difficulty: "standard", domain: "algebra" } as const;

describe("built-in generation is checked", () => {
  it("keeps problems whose answer an independent solve confirms, and writes again for the rest", async () => {
    rounds = [
      [
        { statement: "求 $1+1$ 的值。", answer: "2" },
        { statement: "求方程 $x+y=7$ 中 $y=2$ 时 $x$ 的值。", answer: "4" },
      ],
      [{ statement: "求 $3+3$ 的值。", answer: "6" }],
    ];
    solver = { "求 $1+1$ 的值。": { answer: "2" }, "求方程 $x+y=7$ 中 $y=2$ 时 $x$ 的值。": { answer: "5" }, "求 $3+3$ 的值。": { answer: "6" } };
    const r = await generateProblems({ ...opts, count: 2 });
    expect(r.problems.map((p) => p.answer)).toEqual(["2", "6"]);
    expect(r.problems.every((p) => p.verification?.passed)).toBe(true);
    expect(r.note).toBeUndefined();
    // the second round is told what was rejected and why
    expect(writerPrompts[1]).toContain("求方程 $x+y=7$");
    expect(writerPrompts[1]).toContain("独立解答为 5");
  });

  it("rejects a claim the solver finds false, and a statement Lean refutes", async () => {
    rounds = [
      [
        { statement: "证明：对所有实数 $x$，$x^2 > 0$。", answer: "证明见解答" },
        { statement: "求 $AD$ 的长度。", answer: "√3/2" },
      ],
      [],
      [],
    ];
    solver = { "证明：对所有实数 $x$，$x^2 > 0$。": { claim_holds: false, issue: "x = 0" }, "求 $AD$ 的长度。": { answer: "√3/2" } };
    formalizeMock.mockImplementation(async ({ problemText }: { problemText: string }) =>
      problemText.includes("AD")
        ? { theorem_name: "t", theorem_type: "x", formal_statement: "theorem t …", validation_results: [{ layer: 1, pass: true, detail: "" }, { layer: 6, pass: false, detail: "" }], accepted: false, refutation: { verdict: "refuted", counterexample: "d = 0.8794" } }
        : { theorem_name: "t", theorem_type: "x", formal_statement: "theorem t …", validation_results: [{ layer: 1, pass: true, detail: "" }], accepted: true, refutation: { verdict: "no_counterexample" } },
    );
    const r = await generateProblems({ ...opts, count: 2 });
    expect(r.problems.every((p) => !p.verification?.passed)).toBe(true);
    const [claim, ad] = r.problems;
    expect(claim.verification?.checks.answer.ok).toBe(false);
    expect(claim.verification?.checks.answer.detail).toContain("x = 0");
    expect(ad.verification?.checks.answer.ok).toBe(true);
    expect(ad.verification?.checks.counterexample.ok).toBe(false);
    expect(ad.verification?.checks.counterexample.detail).toContain("0.8794");
    expect(r.note).toBeTruthy();
  });

  it("marks a problem the program proves in Lean", async () => {
    rounds = [[{ statement: "求 $2+2$ 的值。", answer: "4" }]];
    solver = { "求 $2+2$ 的值。": { answer: "4" } };
    proveMock.mockResolvedValue({ tried: [], proof: { source: "theorem t : (2 : ℕ) + 2 = 4 := by\n  decide", strategy: "hammer", verification: {}, tactics: "decide", attempts: 1 } });
    const r = await generateProblems({ ...opts, count: 1 });
    expect(r.problems[0].verification?.lean).toMatchObject({ proved: true, strategy: "hammer" });
  });

  it("an answer the program cannot compare goes to a model judge; a statement that does not compile needs a look", async () => {
    rounds = [[{ statement: "化简 $\\frac{x^2-1}{x-1}$。", answer: "x+1" }], [], []];
    solver = { "化简 $\\frac{x^2-1}{x-1}$。": { answer: "1+x" } };
    chatMock.mockImplementationOnce(chatMock.getMockImplementation()!);
    const impl = chatMock.getMockImplementation()!;
    chatMock.mockImplementation(async (req: { schemaName: string; user: string }) => (req.schemaName === "same_answer" ? { same: true, reason: "" } : impl(req)));
    formalizeMock.mockResolvedValue({ theorem_name: "t", theorem_type: "x", formal_statement: "", validation_results: [{ layer: 1, pass: false, detail: "error" }], accepted: false });
    const r = await generateProblems({ ...opts, count: 1 });
    const v = r.problems[0].verification!;
    expect(v.checks.answer.ok).toBe(true);
    expect(v.checks.answer.detail).toContain("1+x");
    expect(v.checks.counterexample.skipped).toBe(true);
    expect(v.passed).toBe(true);
  });

  it("tells proofs from questions asking for a value", () => {
    expect(isProofProblem("求证：$a^2+b^2 \\ge 2ab$。")).toBe(true);
    expect(isProofProblem("Prove that n^2 + n is even.")).toBe(true);
    expect(isProofProblem("求 $x$ 的值。")).toBe(false);
  });
});
