/**
 * `npm run e2e:report` → bench/E2E.md: what the end-to-end runs on the held-out set say — the
 * share of problems solved (Lean proof + right answer), the funnel behind it, how far the
 * provers reach beyond the families they were written for, who finds the proofs, what it costs,
 * and what changed since the previous run on the same set.
 *
 * Held-out discipline: problems of the `test` split appear only in counts. Per-problem lines
 * (what failed and why) are printed for the `dev` split alone, so nobody tunes the program on
 * the problems that are meant to measure it.
 */
import { PROGRAM_STRATEGIES, solved, stopOf, type EvalRow, type RunFile, type Stop } from "./outcome";

const TOPIC: Record<string, string> = { number_theory: "数论", combinatorics: "组合", geometry: "几何", algebra: "代数" };
const topicName = (t: string) => TOPIC[t] ?? t;

const STOP: Record<Stop, string> = {
  solved: "已解决（Lean 已证，答案正确）",
  proved_wrong_answer: "证了，但答案是错的（陈述不是原题）",
  proved_unchecked_answer: "证了，答案没能自动比对",
  wrong_answer: "答案错",
  not_formalized: "没有通过检查的陈述",
  not_proved: "陈述通过，没证出来",
  no_lean: "没有进行 Lean 证明",
  error: "运行出错（无结论）",
};

/** Wilson 95 % interval of a share, in percent. */
export function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const z = 1.96;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, ((c - h) / d) * 100), Math.min(100, ((c + h) / d) * 100)];
}

const pct = (k: number, n: number) => (n ? `${Math.round((k / n) * 100)}%` : "—");
const share = (k: number, n: number) => `${k}/${n}（${pct(k, n)}）`;
const usd = (x: number) => `$${x < 1 ? x.toFixed(3) : x.toFixed(2)}`;
const mins = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} 秒` : `${(ms / 60_000).toFixed(1)} 分钟`);

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

function table(head: string[], rows: string[][]): string[] {
  return [`| ${head.join(" | ")} |`, `|${head.map(() => " --- ").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)];
}

interface Tally {
  n: number;
  find: number;
  answerRight: number;
  answerWrong: number;
  answerUnknown: number;
  formalized: number;
  proved: number;
  solved: number;
}

function tally(rows: EvalRow[]): Tally {
  const find = rows.filter((r) => r.kind === "find" && r.status === "done");
  return {
    n: rows.length,
    find: find.length,
    answerRight: find.filter((r) => r.answer_ok === true).length,
    answerWrong: find.filter((r) => r.answer_ok === false).length,
    answerUnknown: find.filter((r) => r.answer_ok === null).length,
    formalized: rows.filter((r) => r.formalized).length,
    proved: rows.filter((r) => r.proved).length,
    solved: rows.filter(solved).length,
  };
}

function funnelRow(label: string, rows: EvalRow[]): string[] {
  const t = tally(rows);
  return [label, String(t.n), t.find ? share(t.answerRight, t.find) : "—", share(t.formalized, t.n), share(t.proved, t.n), `**${share(t.solved, t.n)}**`];
}

const FUNNEL_HEAD = ["", "题数", "答案正确（求值题）", "陈述通过", "Lean 已证", "端到端解决"];

function runLabel(r: RunFile): string {
  return r.meta.at.slice(0, 16).replace("T", " ");
}

function cost(rows: EvalRow[]): number | undefined {
  const xs = rows.map((r) => r.cost_usd).filter((x): x is number => x !== undefined);
  return xs.length ? xs.reduce((a, b) => a + b, 0) : undefined;
}

function short(s: string | undefined, n: number): string {
  if (!s) return "";
  const t = s.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** Runs on the same set as `run`, older first. */
function earlier(run: RunFile, all: RunFile[]): RunFile[] {
  return all.filter((r) => r !== run && r.meta.set_hash === run.meta.set_hash && r.meta.lean === run.meta.lean && r.meta.at < run.meta.at).sort((a, b) => a.meta.at.localeCompare(b.meta.at));
}

/** The report of every run given (the latest in detail). */
export function e2eReport(runs: RunFile[], opts: { now?: Date } = {}): string {
  const sorted = [...runs].filter((r) => r.rows.length).sort((a, b) => a.meta.at.localeCompare(b.meta.at));
  const out: string[] = ["# 端到端评测（留出题集）", ""];
  out.push(
    `由 \`npm run e2e:report\` 生成${opts.now ? `（${opts.now.toISOString().slice(0, 16).replace("T", " ")} UTC）` : ""}。每道题按用户的用法跑一遍：输入题目文本 → 求解 → Lean 形式化并证明。`,
    "",
    "- **端到端解决** = Lean 证明通过，且（求值题）答案与参考答案一致。这是主指标。",
    "- 留出部分（test）只报总数，不列题目；逐题情况只列开发部分（dev）。不要针对 test 里的某一道题改程序。",
    "- 评测运行不写入证明记忆和学到的规则，所以重复运行不会因为“记住了上次的证明”而变好。",
    "- 陈述是否忠实于原题由产品自己的检查层判断，这里没有另外核对；“证了但答案错”是唯一能自动发现的不忠实信号。",
    "",
  );
  if (!sorted.length) {
    out.push("还没有运行结果。先启动应用（`npm run dev`），再运行 `npm run e2e -- --sample 24 --max-cost 5`。", "");
    return out.join("\n");
  }

  // ── every run, one line
  out.push("## 历次运行", "");
  out.push(
    ...table(
      ["运行", "题集", "范围", "题数", "端到端解决", "95% 区间", "Lean 已证", "答案正确", "花费", "每解决一题", "用时", "提交"],
      sorted.map((r) => {
        const t = tally(r.rows);
        const [lo, hi] = wilson(t.solved, t.n);
        const c = cost(r.rows);
        const splits = [...new Set(r.rows.map((x) => x.split))].sort().join("+");
        return [
          runLabel(r),
          `${r.meta.set} \`${r.meta.set_hash.slice(0, 6)}\``,
          `${splits}${r.meta.lean ? "" : "，仅求解"}${r.rows.length < r.meta.selected ? `，未跑完（${r.rows.length}/${r.meta.selected}）` : ""}`,
          String(t.n),
          `**${share(t.solved, t.n)}**`,
          `${Math.round(lo)}–${Math.round(hi)}%`,
          share(t.proved, t.n),
          t.find ? share(t.answerRight, t.find) : "—",
          c !== undefined ? usd(c) : "—",
          c !== undefined && t.solved ? usd(c / t.solved) : "—",
          r.ended ? mins(r.ended.wall_ms) : "—",
          r.meta.commit ? `\`${r.meta.commit.slice(0, 7)}\`` : "—",
        ];
      }),
    ),
    "",
  );

  const run = sorted[sorted.length - 1];
  const rows = run.rows;
  const t = tally(rows);
  const [lo, hi] = wilson(t.solved, t.n);
  const models = [...new Set(rows.flatMap((r) => r.models ?? []))];
  out.push(`## 最近一次运行：${runLabel(run)}`, "");
  out.push(
    `题集 ${run.meta.set}（\`${run.meta.set_hash}\`，共 ${run.meta.set_size} 题），本次 ${rows.length} 题${rows.length < run.meta.selected ? `（计划 ${run.meta.selected} 题${run.ended?.stopped ? `，${run.ended.stopped}` : "，未跑完"}）` : ""}。` +
      `${models.length ? `模型：${models.join("、")}。` : ""}${run.meta.lean ? "" : "这次只求解，没有做 Lean 证明。"}`,
    "",
    `**端到端解决 ${share(t.solved, t.n)}**，95% 区间 ${Math.round(lo)}–${Math.round(hi)}%。${t.n < 60 ? "题数少，区间宽：几个百分点的变化不说明问题。" : "两次运行相差在区间之内时，不要当作变好或变差。"}`,
    "",
  );

  // ── funnel
  out.push("### 漏斗", "");
  const bySplit = ["test", "dev"].filter((s) => rows.some((r) => r.split === s));
  out.push(...table(FUNNEL_HEAD, [...bySplit.map((s) => funnelRow(s === "test" ? "留出（test）" : "开发（dev）", rows.filter((r) => r.split === s))), ...(bySplit.length > 1 ? [funnelRow("合计", rows)] : [])]), "");
  if (t.answerUnknown) out.push(`求值题里有 ${t.answerUnknown} 题的答案没能自动比对（写法无法求值），不计入“答案正确”。`, "");

  // ── by topic
  const topics = [...new Set(rows.map((r) => r.topic))];
  if (topics.length > 1) {
    out.push("### 按题型", "");
    out.push(...table(FUNNEL_HEAD, topics.map((tp) => funnelRow(topicName(tp), rows.filter((r) => r.topic === tp)))), "");
  }

  // ── seen vs new families
  const seen = rows.filter((r) => r.seen_family);
  const fresh = rows.filter((r) => !r.seen_family);
  if (seen.length && fresh.length) {
    const a = tally(seen);
    const b = tally(fresh);
    out.push("### 泛化：程序见过的题型 与 没见过的题型", "");
    out.push("“见过”指程序里已经有针对这一类题的专门路线（题目本身是新的）；“没见过”指没有专门路线的题型。两者的差距就是专用证明器的泛化缺口。", "");
    out.push(...table(FUNNEL_HEAD, [funnelRow("见过的题型", seen), funnelRow("没见过的题型", fresh)]), "");
    if (a.n >= 10 && b.n >= 10) {
      const gap = Math.round((a.solved / a.n - b.solved / b.n) * 100);
      out.push(gap > 0 ? `差距 ${gap} 个百分点。` : "没见过的题型并不更差。", "");
    }
    const levels = [...new Set(rows.map((r) => r.level))].sort();
    if (levels.length > 1) {
      out.push(...table(FUNNEL_HEAD, levels.map((lv) => funnelRow(`难度 ${lv}`, rows.filter((r) => r.level === lv)))), "");
    }
  }

  // ── who proves
  const proofs = rows.filter((r) => r.proved);
  if (proofs.length) {
    const by = new Map<string, number>();
    for (const r of proofs) by.set(r.strategy ?? "?", (by.get(r.strategy ?? "?") ?? 0) + 1);
    const program = proofs.filter((r) => PROGRAM_STRATEGIES.has(r.strategy ?? "")).length;
    const memory = proofs.filter((r) => r.strategy === "memory").length;
    out.push("### 证明是谁找到的", "");
    out.push(`${proofs.length} 个证明里，程序自己写的 ${program} 个（不调模型），证明记忆重放 ${memory} 个，模型写的 ${proofs.length - program - memory} 个。`, "");
    out.push(...table(["路线", "证明数"], [...by.entries()].sort((x, y) => y[1] - x[1]).map(([k, v]) => [k, String(v)])), "");
  }

  // ── where it stops
  const stops = new Map<Stop, EvalRow[]>();
  for (const r of rows) stops.set(stopOf(r), [...(stops.get(stopOf(r)) ?? []), r]);
  out.push("### 停在哪一步", "");
  out.push(
    ...table(
      ["结果", "题数", "占比", "花费"],
      (Object.keys(STOP) as Stop[])
        .filter((k) => stops.has(k))
        .map((k) => {
          const g = stops.get(k)!;
          const c = cost(g);
          return [STOP[k], String(g.length), pct(g.length, rows.length), c !== undefined ? usd(c) : "—"];
        }),
    ),
    "",
  );
  const types = new Map<string, number>();
  for (const r of rows) if (r.problem_type) types.set(r.problem_type, (types.get(r.problem_type) ?? 0) + 1);
  if (types.size) out.push(`产品对题目的分类：${[...types.entries()].sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}`).join("，")}。`, "");

  // ── time and money
  const total = cost(rows);
  const times = rows.filter((r) => r.status === "done").map((r) => r.ms);
  out.push("### 时间和花费", "");
  const failedRows = rows.filter((r) => !solved(r));
  const failedCost = cost(failedRows);
  out.push(
    [
      total !== undefined ? `总花费 ${usd(total)}，平均每题 ${usd(total / rows.length)}${t.solved ? `，每解决一题 ${usd(total / t.solved)}` : ""}。` : "没有费用数据（服务器没有配置 LLM_PRICES）。",
      total !== undefined && failedCost !== undefined && total > 0 ? `没解决的题花了 ${usd(failedCost)}（${Math.round((failedCost / total) * 100)}%）。` : "",
      times.length ? `每题用时中位数 ${mins(median(times))}，最长 ${mins(Math.max(...times))}。` : "",
    ]
      .filter(Boolean)
      .join(""),
    "",
  );

  // ── against the previous run on the same set
  const before = earlier(run, sorted).pop();
  if (before) {
    const prev = new Map(before.rows.map((r) => [r.id, r]));
    const both = rows.filter((r) => prev.has(r.id));
    if (both.length) {
      const was = both.filter((r) => solved(prev.get(r.id)!)).length;
      const now = both.filter(solved).length;
      const gained = both.filter((r) => solved(r) && !solved(prev.get(r.id)!));
      const lost = both.filter((r) => !solved(r) && solved(prev.get(r.id)!));
      const [plo, phi] = wilson(was, both.length);
      const inside = (now / both.length) * 100 >= plo && (now / both.length) * 100 <= phi;
      out.push(`### 与上一次（${runLabel(before)}）相比`, "");
      out.push(
        `两次都跑过的 ${both.length} 题：端到端解决 ${share(was, both.length)} → ${share(now, both.length)}；新解决 ${gained.length} 题，丢掉 ${lost.length} 题。` +
          (inside ? "变化在上一次的 95% 区间之内，不能算作变好或变差。" : now > was ? "超出了上一次的 95% 区间。" : "低于上一次的 95% 区间。"),
        "",
      );
      const devGained = gained.filter((r) => r.split === "dev").map((r) => r.id);
      const devLost = lost.filter((r) => r.split === "dev").map((r) => r.id);
      if (devGained.length) out.push(`dev 新解决：${devGained.join("、")}。`);
      if (devLost.length) out.push(`dev 丢掉：${devLost.join("、")}。`);
      const testGained = gained.length - devGained.length;
      const testLost = lost.length - devLost.length;
      if (testGained || testLost) out.push(`test：新解决 ${testGained} 题，丢掉 ${testLost} 题（不列题号）。`);
      out.push("");
    }
  }

  // ── dev details
  const dev = rows.filter((r) => r.split === "dev");
  if (dev.length) {
    out.push("### 开发部分（dev）逐题", "");
    out.push(
      ...table(
        ["题", "题型", "分类", "答案", "陈述", "证明", "用时", "花费", "没解决的原因"],
        dev.map((r) => [
          r.id,
          topicName(r.topic),
          r.problem_type ?? "—",
          r.kind === "prove" ? "—" : r.answer_ok === true ? "✓" : r.answer_ok === false ? `✗ ${short(r.answer, 30)}` : `? ${short(r.answer, 30)}`,
          r.formalized ? "✓" : "✗",
          r.proved ? `✓ ${r.strategy ?? ""}` : "✗",
          mins(r.ms),
          r.cost_usd !== undefined ? usd(r.cost_usd) : "—",
          solved(r) ? "" : short(r.status === "error" ? `运行出错：${r.error ?? ""}` : (r.failure ?? STOP[stopOf(r)]), 160),
        ]),
      ),
      "",
    );
  }
  if (rows.some((r) => r.split === "test")) out.push("留出部分（test）不列逐题结果。要诊断，请只看 dev；一道 test 题一旦被打开看过，就把它移到 dev（题集的哈希会变，之后的运行不再与之前的比较）。", "");
  return out.join("\n");
}
