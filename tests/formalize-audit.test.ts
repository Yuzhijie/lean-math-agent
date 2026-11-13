import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { auditReport, auditSummary, heldoutItems, minif2fItems, parseLabels, readingOf, readLabelFile, sessionItems, statementKey, VERDICTS, type AuditInput, type Label } from "@/lib/formalize-audit";
import type { EvalRow, RunFile } from "@/lib/e2e/outcome";
import { problemWithFigure } from "@/lib/bank/problem-figures";
import type { LeanProofAttempt, Session } from "@/lib/types";

let clock = 1_000;
function session(problem: string, o: Partial<Session> & { attempt?: Partial<LeanProofAttempt> } = {}): Session {
  const { attempt, ...rest } = o;
  clock += 1_000;
  return {
    id: `s${clock}`,
    problem_text: problem,
    pipeline_stage: "complete",
    formal_validated: false,
    validation_results: [],
    methods: [],
    steps: [],
    assembled_lean: "",
    build_status: "idle",
    sorry_labels: [],
    created_at: clock,
    updated_at: clock,
    ...(attempt ? { lean_proof_attempt: { attempted: true, success: false, ...attempt } } : {}),
    ...rest,
  } as Session;
}
const stmt = (type: string) => `theorem t ${type} := by sorry`;
const label = (key: string, verdict: Label["verdict"], note?: string): [string, Label] => [key, { key, verdict, ...(note ? { note } : {}) }];

describe("statementKey", () => {
  it("is the statement's type together with the problem it formalizes", () => {
    const k = statementKey(stmt(": ∀ n : ℕ, n + 0 = n"), "证明 n + 0 = n");
    expect(k).toMatch(/^[0-9a-f]{12}$/);
    // whitespace, the theorem's name and the proof do not matter
    expect(statementKey("import Mathlib\n\ntheorem other :\n  ∀ n : ℕ,  n + 0 = n := by\n  simp\n", "证明  n + 0 = n\n")).toBe(k);
    expect(statementKey(": ∀ n : ℕ, n + 0 = n", "证明 n + 0 = n")).toBe(k);
    // the same statement for another problem is another reading; so is another statement
    expect(statementKey(stmt(": ∀ n : ℕ, n + 0 = n"), "证明对任意 n，n + 0 = n 且 0 + n = n")).not.toBe(k);
    expect(statementKey(stmt(": ∀ n : ℕ, 0 + n = n"), "证明 n + 0 = n")).not.toBe(k);
    // no statement: the problem alone
    expect(statementKey(undefined, "证明 n + 0 = n")).toBe(statementKey("  ", "证明 n + 0 = n"));
  });
});

describe("labels", () => {
  it("one verdict per statement, from the known list", () => {
    const ok = JSON.stringify({ labels: [{ key: "0123456789ab", verdict: "F" }, { key: "ba9876543210", verdict: "B", note: "焦点是算好的", source: "heldout", about: "ge-16" }] });
    expect(parseLabels(ok).get("ba9876543210")).toMatchObject({ verdict: "B", note: "焦点是算好的" });
    expect(() => parseLabels(JSON.stringify({ labels: [{ key: "0123456789ab", verdict: "F" }, { key: "0123456789ab", verdict: "E" }] }))).toThrow(/occurs twice/);
    expect(() => parseLabels(JSON.stringify({ labels: [{ key: "0123456789ab", verdict: "Q" }] }))).toThrow();
    expect(() => parseLabels(JSON.stringify({ labels: [{ key: "short", verdict: "F" }] }))).toThrow();
  });

  it("the repository's label file is well formed", () => {
    const text = readFileSync(path.join(__dirname, "..", "bench", "formalization-labels.json"), "utf8");
    const { labels, readBy } = readLabelFile(text);
    expect(labels.size).toBeGreaterThan(100);
    // a reading is a judgement: the file says whose
    expect(readBy).toBeTruthy();
    for (const l of labels.values()) expect(Object.keys(VERDICTS)).toContain(l.verdict);
    // every verdict other than "faithful" says why
    for (const l of labels.values()) if (l.verdict !== "F") expect(l.note, l.key).toBeTruthy();
    // no control characters (a stored problem may hold what "\a" of unescaped LaTeX became)
    expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f]/);
  });
});

describe("sessionItems", () => {
  it("one item per problem: the session that proved it, else the latest with a statement", () => {
    const proved = session("求 gcd(12, 18)", { attempt: { success: true, strategy: "hammer", formal_statement: stmt(": Nat.gcd 12 18 = 6") } });
    const later = session("求 gcd(12, 18)", { attempt: { formal_statement: stmt(": Nat.gcd 12 18 = 6 ∧ True"), failure_reason: "陈述通过了检查，但没有证出来", statement_accepted: true } });
    const first = session("求最小的 n", { attempt: { formal_statement: stmt(": IsLeast {n : ℕ | 0 < n} 1"), failure_reason: "没能写出一条通过检查的 Lean 陈述，所以没有开始证明" } });
    const second = session("求最小的 n", { attempt: { formal_statement: stmt(": IsLeast {n : ℕ | 0 < n ∧ 3 ∣ n} 3"), failure_reason: "陈述通过了检查", statement_accepted: true } });
    const items = sessionItems([later, proved, second, first]);
    expect(items.map((i) => [i.id, i.outcome, i.strategy])).toEqual([
      [proved.id, "proved", "hammer"],
      [second.id, "accepted", undefined],
    ]);
    expect(items[0].statement).toBe(": Nat.gcd 12 18 = 6");
    expect(items[0].key).toBe(statementKey(": Nat.gcd 12 18 = 6", "求 gcd(12, 18)"));
  });

  it("the same problem read with its figure twice is one problem", () => {
    const a = session(problemWithFigure("How many triangles?", "7 lines over 13 points"), { attempt: { formal_statement: stmt(": 3 * 6 = 18"), failure_reason: "No Lean statement passed the checks" } });
    const b = session(problemWithFigure("How many   triangles?", "a drawing of 9 lines"), { attempt: { success: true, strategy: "trivial", formal_statement: stmt(": (18 : ℕ) = 18") } });
    const items = sessionItems([a, b]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: b.id, outcome: "proved" });
    expect(items[0].scope?.figure).toBe(true);
  });

  it("leaves out what never reached a checked statement, and the held-out set's problems", () => {
    const notStarted = session("解方程", { lean_proof_attempt: { attempted: false, success: false } });
    const cutShort = session("证明 A", { pipeline_stage: "solving", theorem_name: "a", theorem_type: ": True" });
    const heldout = session("留出题  一", { attempt: { success: true, formal_statement: stmt(": 1 = 1") } });
    const kept = session("证明 B", { theorem_name: "b", theorem_type: "(x : ℝ) : x = x", formal_validated: true, build_status: "ok" });
    const items = sessionItems([notStarted, cutShort, heldout, kept], new Set(["留出题 一"]));
    expect(items.map((i) => i.id)).toEqual([kept.id]);
    expect(items[0]).toMatchObject({ outcome: "proved", strategy: "theorem pipeline", statement: "(x : ℝ) : x = x" });
  });

  it("tells proved / accepted / rejected / gave up / error apart", () => {
    const of = (o: Parameters<typeof session>[1]) => sessionItems([session(`p${clock}`, o)])[0].outcome;
    expect(of({ attempt: { success: true, formal_statement: stmt(": 1 = 1") } })).toBe("proved");
    expect(of({ attempt: { statement_accepted: true, failure_reason: "已尝试：…" } })).toBe("accepted");
    expect(of({ attempt: { failure_reason: "The statement passed the checks, but no proof was found" } })).toBe("accepted");
    // the stepwise route of older versions ended in "source contains sorry" after the statement was validated
    expect(of({ formal_validated: true, attempt: { failure_reason: "Lean 验证失败: source contains `sorry`" } })).toBe("accepted");
    expect(of({ attempt: { failure_reason: "没能写出一条通过检查的 Lean 陈述，所以没有开始证明" } })).toBe("rejected");
    expect(of({ attempt: { failure_reason: "Autoformalization did not pass validation" } })).toBe("rejected");
    expect(of({ attempt: { failure_reason: "计算问题的形式化证明需要复杂的数值推导，当前自动证明能力有限" } })).toBe("gave_up");
    expect(of({ attempt: { failure_reason: "形式化过程出错: timeout" } })).toBe("error");
    expect(of({ theorem_type: ": True", formal_statement: stmt(": True"), validation_results: [{ layer: 2, pass: false, detail: "trivial" }] })).toBe("rejected");
    expect(of({ theorem_type: ": True", formal_statement: stmt(": True"), formal_validated: true })).toBe("accepted");
  });

  it("knows the answer's numbers when it looks for worked-out ones", () => {
    const type = ": let c : ℝ := 5; |4 * c - 3 * 0| / Real.sqrt (4 ^ 2 + 3 ^ 2) = 8 / 2";
    const s = session("求焦点到渐近线的距离，双曲线 x^2/9 - y^2/16 = 1", { nl_solution: { final_answer: "$4$" } as Session["nl_solution"], attempt: { success: true, formal_statement: stmt(type) } });
    expect(sessionItems([s])[0].scope).toEqual({ figure: false, closed: true, derived: ["5", "3"] });
    // without the stored answer, 4 is one more number the problem did not give
    expect(sessionItems([{ ...s, nl_solution: undefined }])[0].scope?.derived).toEqual(["5", "4", "3"]);
  });
});

const row = (id: string, o: Partial<EvalRow> = {}): EvalRow => ({ id, split: "test", topic: "algebra", kind: "find", level: 2, seen_family: false, status: "done", answer_ok: true, lean_attempted: true, formalized: true, proved: true, strategy: "hammer", statement: stmt(`: ${id.length} = ${id.length}`), ms: 1, ...o });
const run = (at: string, rows: EvalRow[]): RunFile => ({ file: at, meta: { type: "run", at, set: "heldout-zh-v1", set_hash: "abc", set_size: 120, selected: rows.length, base: "", lean: true, args: [] }, rows });

describe("heldoutItems", () => {
  it("dev statements are items, test statements only counts; the latest run of a problem wins", () => {
    const first = run("2026-11-12T00:00:00Z", [row("ge-16", { split: "dev", statement: stmt(": (1 : ℝ) = 1") }), row("al-02"), row("al-03", { proved: false }), row("al-04", { proved: false, formalized: false, statement: undefined })]);
    const second = run("2026-11-13T00:00:00Z", [row("ge-16", { split: "dev", statement: stmt(": |4 * (5 : ℝ)| / 5 = 4"), strategy: "trivial" }), row("nt-01", { split: "dev", lean_attempted: false, formalized: false, proved: false }), row("al-05", { status: "error" })]);
    const h = heldoutItems([second, first], new Map([["ge-16", { text: "求双曲线 x^2/9 - y^2/16 = 1 的右焦点到渐近线的距离", answer: "4" }]]));
    expect(h.items).toHaveLength(1);
    expect(h.items[0]).toMatchObject({ source: "heldout", id: "ge-16", outcome: "proved", strategy: "trivial", statement: ": |4 * (5 : ℝ)| / 5 = 4" });
    expect(h.items[0].key).toBe(statementKey(": |4 * (5 : ℝ)| / 5 = 4", "heldout:ge-16"));
    expect(h.items[0].scope?.derived).toEqual(["5"]);
    expect(h.test).toEqual({ attempted: 3, formalized: 2, proved: 1 });
  });
});

describe("miniF2F statements", () => {
  const rows = [
    { id: "a", accepted: true, verdict: "same", official: "(x : ℝ) : x = x", ours: "(y : ℝ) : y = y" },
    { id: "b", accepted: true, verdict: "not_shown", official: "(n : ℕ) : n ^ 2 ≥ 0", ours: "(x : ℝ) : x ^ 2 ≥ 0" },
    { id: "c", accepted: false, verdict: "not_formalized", official: ": True" },
    { id: "d", accepted: true, verdict: "official_broken", official: ": broken", ours: ": True" },
  ];

  it("what the program showed equal needs no reading; the rest does", () => {
    const items = minif2fItems(rows);
    expect(items.map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(items[2].statement).toBeUndefined();
    const labels = new Map([label(items[1].key, "F", "在 ℝ 上，更一般")]);
    expect(readingOf(items[0], new Map())).toEqual({ verdict: "F", by: "program" });
    expect(readingOf(items[1], new Map())).toBeUndefined();
    expect(readingOf(items[1], labels)).toEqual({ verdict: "F", note: "在 ℝ 上，更一般", by: "label" });
  });
});

describe("auditReport", () => {
  const sessions = sessionItems([
    session("求 gcd(12, 18)", { attempt: { success: true, strategy: "hammer", formal_statement: stmt(": Nat.gcd 12 18 = 6") } }),
    session(problemWithFigure("Jake used 4 and served 3. How many were not used?", "12 vegetables"), { attempt: { success: true, strategy: "trivial", formal_statement: stmt(": (12 : ℕ) - 4 - 3 = 5") } }),
    session("求内切圆切点构成的三角形面积，AB=13，AC=14，BC=15", { attempt: { statement_accepted: true, failure_reason: "已尝试…", formal_statement: stmt(": (7 : ℝ) * 8 * 6 / 2 = 168") } }),
    session("求最小的 n 使 2^n ≡ 1 (mod 7)", { attempt: { failure_reason: "没能写出一条通过检查的 Lean 陈述，所以没有开始证明", formal_statement: stmt(": IsLeast {n : ℕ | 0 < n ∧ 7 ∣ 2 ^ n - 1} 6") } }),
    session("证明 n + 0 = n", { attempt: { failure_reason: "没能写出一条通过检查的 Lean 陈述，所以没有开始证明", formal_statement: stmt(": ∀ n : ℕ, n + 0 = n") } }),
    session("新题：求 1 + 1", { attempt: { success: true, strategy: "trivial", formal_statement: stmt(": 1 + 1 = 2") } }),
  ]);
  const [gcd, veg, incircle, order, easy, fresh] = sessions;
  const heldout = heldoutItems([run("2026-11-12T00:00:00Z", [row("ge-16", { split: "dev", statement: stmt("(x : ℝ) (h : x = 4) : x ^ 2 = 16") }), row("al-02"), row("al-03", { proved: false })])]);
  const minif2f = minif2fItems([
    { id: "same_one", accepted: true, verdict: "same", official: ": True", ours: ": True" },
    { id: "general_one", accepted: true, verdict: "not_shown", official: "(n : ℕ) : 0 ≤ n ^ 2", ours: "(x : ℝ) : 0 ≤ x ^ 2" },
    { id: "narrow_one", accepted: true, verdict: "not_shown", official: "(a : ℝ) : a = a", ours: "(a : ℕ) : a = a" },
  ]);
  const labels = new Map<string, Label>([
    label(gcd.key, "F"),
    label(veg.key, "E", "12 是数图得到的"),
    label(incircle.key, "B", "切线长是当作已知写进去的"),
    label(order.key, "K", "答案 6 不是最小的"),
    label(easy.key, "R", "被当作太简单"),
    label(heldout.items[0].key, "F"),
    label(minif2f[1].key, "F", "更一般"),
    label(minif2f[2].key, "A", "写成了 ℕ"),
    label("ffffffffffff", "F"),
  ]);
  const input: AuditInput = { sessions, heldout, minif2f, labels, meta: { date: "2026-11-13", commit: "abc1234", e2e: "1 次运行", formalize: "2026-10-29，3 道题", readBy: "Claude（2026-11-13）" } };
  const md = auditReport(input);

  it("says how many statements are the problem, and how solid the proofs are", () => {
    expect(md).toContain("读法是判断，不是证明");
    expect(md).toContain("目前的结论由 Claude（2026-11-13） 读出");
    expect(md).toContain("6 道题走到了 Lean 这一步，4 条陈述没有被检查层拒绝，读过 3 条：忠实 1，空心 2。");
    expect(md).toContain("空心 2/3（67%）");
    expect(md).toContain("3 个证明里（读过 2 个），1 个证的确实是原题；1 个（50%）证的是空心陈述");
    expect(md).toContain("2 道题没有陈述通过检查；读下来拒绝得对 1 条，错拒 1 条。");
    expect(md).toMatch(/\| \*\*E\*\* \| 空心 \| 1 \| 1 \|/);
    expect(md).toMatch(/\| \*\*E\*\* \| Jake used 4 .* \| 已证（trivial） \| 12 是数图得到的 \|/);
  });

  it("reads miniF2F's unconnected statements instead of calling them unfaithful", () => {
    expect(md).toContain("程序能证明相同或等价的 1/3（33%）；读下来忠实的 2/3（67%）");
    expect(md).toContain("“没证出等价”的 2 条里读过 2 条，1 条是忠实的");
    expect(md).toMatch(/\| 没证出等价 \| 2 \| 1 \| 1 \| 0 \| 0 \| 0 \|/);
    expect(md).toMatch(/\| narrow\\_one \| \*\*A\*\* 有偏差 \| 写成了 ℕ \|/);
  });

  it("never lists a test problem of the held-out set", () => {
    expect(md).toContain("| ge-16 | 已证（hammer） | **F** 忠实 |");
    expect(md).toContain("test：2 道题走到 Lean，2 条陈述通过检查，1 条已证");
    expect(md).not.toMatch(/al-02|al-03/);
  });

  it("compares the program's two signals with the reading", () => {
    expect(md).toMatch(/题目带图（陈述里图的内容是模型读图写进去的） \| 1 \| 1 \| 0 \|/);
    expect(md).toMatch(/陈述是不含未知量的算式，且含题目没给的数 \| 1 \| 1 \| 0 \|/);
    expect(md).toContain("读为空心的共 2 条，两个信号合起来能指出其中 2 条");
  });

  it("lists what nobody has read, with the key to label it under", () => {
    expect(auditSummary(input)).toEqual({ accepted: 8, read: 7, unread: 1, stale: 1 });
    expect(md).toContain("还有 1 条陈述没读过");
    expect(md).toContain(`- \`${fresh.key}\` 会话`);
    expect(md).toContain("陈述：`: 1 + 1 = 2`");
    expect(md).toContain("标签文件里有 1 条对应的陈述已经不在当前数据里");
    const done = auditReport({ ...input, labels: new Map([...labels, label(fresh.key, "F")]) });
    expect(done).toMatch(/## 五、还没读过的陈述\n\n没有。/);
  });
});
