/**
 * `npm run auto:rules [--out bench/AUTO-RULES.md] [--json]`: the automation search's rule table
 * (lib/lean/auto/rules.ts — built-in, registered and rule-file rules, in the order they are
 * tried) with each rule's hit rate from AUTO_RULE_STATS_PATH (default .data/auto-rule-stats.json).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { allRules } from "../lib/lean/auto/rules";
import { readRuleStats, ruleStatsMarkdown, statsPath } from "../lib/lean/auto/stats";

const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const out = outAt >= 0 ? args[outAt + 1] : "bench/AUTO-RULES.md";
const stats = readRuleStats();
if (args.includes("--json")) {
  console.log(JSON.stringify(stats, null, 2));
} else {
  // the search's own steps outside the table
  const docs = new Map<string, { kind: string; doc: string; order: number }>();
  allRules().forEach((r, i) => docs.set(r.id, { kind: r.kind, doc: r.doc, order: i }));
  docs.set("certificate", { kind: "finisher", doc: "linear_combination from the polynomial certificate (certificate.ts), after the finishers", order: docs.size + 0.5 });
  docs.set("linear-values", { kind: "splitter", doc: "values of the unknowns a linear system fixes (linear.ts), before the splitters", order: docs.size + 0.6 });
  const md = ruleStatsMarkdown(stats, docs) + `\n数据：\`${path.relative(process.cwd(), statsPath())}\`。新增策略：在 lib/lean/auto/rules.ts 的 BUILTIN_RULES 加一条规则，或写进 .data/auto-rules.json。\n`;
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, md);
  console.log(md);
}
