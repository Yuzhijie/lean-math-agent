/**
 * Hit rates of the automation search's rules (rules.ts). For every rule: how often one of its
 * tactics was tried, how often it worked (a finisher closed the goal; a splitter's goals were all
 * closed), and how often it is part of a proof that was found. Kept in AUTO_RULE_STATS_PATH
 * (default .data/auto-rule-stats.json); AUTO_RULE_STATS=off records nothing. `npm run auto:rules`
 * writes the table (bench/AUTO-RULES.md).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface RuleCounts {
  /** tactics of the rule applied */
  tried: number;
  /** a finisher closed its goal / a splitter's goals were all closed */
  worked: number;
  /** part of a proof the search found */
  proofs: number;
  /** searches in which a tactic of the rule was tried */
  searches: number;
}

export interface RuleStatsFile {
  version: 1;
  searches: number;
  proved: number;
  rules: Record<string, RuleCounts>;
  updated?: string;
}

export const statsPath = () => process.env.AUTO_RULE_STATS_PATH ?? path.join(process.cwd(), ".data", "auto-rule-stats.json");
const enabled = () => process.env.AUTO_RULE_STATS !== "off";

/** A rule's counts (rule ids such as "constructor" are also names on Object.prototype). */
const own = (rules: Record<string, RuleCounts>, id: string): RuleCounts | undefined => (Object.hasOwn(rules, id) ? rules[id] : undefined);

const empty = (): RuleStatsFile => ({ version: 1, searches: 0, proved: 0, rules: {} });

export function readRuleStats(p = statsPath()): RuleStatsFile {
  try {
    if (!existsSync(p)) return empty();
    const raw = JSON.parse(readFileSync(p, "utf8")) as RuleStatsFile;
    return raw && raw.version === 1 && raw.rules ? raw : empty();
  } catch {
    return empty();
  }
}

/** One search's counts, added to the file when the search ends. */
export class RuleTally {
  readonly rules = new Map<string, RuleCounts>();
  private get(id: string): RuleCounts {
    let c = this.rules.get(id);
    if (!c) this.rules.set(id, (c = { tried: 0, worked: 0, proofs: 0, searches: 1 }));
    return c;
  }
  tried(id: string | undefined) {
    if (id) this.get(id).tried++;
  }
  worked(id: string | undefined) {
    if (id) this.get(id).worked++;
  }
  proof(ids: (string | undefined)[]) {
    for (const id of new Set(ids)) if (id) this.get(id).proofs++;
  }
  /** Added to the stats file (and the in-memory copy learnedScore reads). */
  flush(proved: boolean): void {
    if (!enabled() || !this.rules.size) return;
    const p = statsPath();
    const file = readRuleStats(p);
    file.searches++;
    if (proved) file.proved++;
    for (const [id, c] of this.rules) {
      const f = own(file.rules, id) ?? (file.rules[id] = { tried: 0, worked: 0, proofs: 0, searches: 0 });
      f.tried += c.tried;
      f.worked += c.worked;
      f.proofs += c.proofs;
      f.searches += c.searches;
    }
    file.updated = new Date().toISOString();
    try {
      mkdirSync(path.dirname(p), { recursive: true });
      const tmp = `${p}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(file, null, 1));
      renameSync(tmp, p);
    } catch {
      // statistics never stop a proof
    }
    cached = undefined;
  }
}

let cached: { at: number; path: string; file: RuleStatsFile } | undefined;

/** A rule's record for AUTO_RULE_ORDER=learned: worked / tried with a prior of 1 in 3. */
export function learnedScore(id: string): number {
  const p = statsPath();
  if (!cached || cached.path !== p || Date.now() - cached.at > 60_000) cached = { at: Date.now(), path: p, file: readRuleStats(p) };
  const c = own(cached.file.rules, id);
  if (!c) return 1 / 3;
  return (c.worked + c.proofs + 1) / (c.tried + 3);
}

/** The table for the report. */
export function ruleStatsMarkdown(file: RuleStatsFile, docs: Map<string, { kind: string; doc: string; order: number }>): string {
  const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "—");
  const ids = [...new Set([...docs.keys(), ...Object.keys(file.rules)])];
  ids.sort((a, b) => (docs.get(a)?.order ?? 1e9) - (docs.get(b)?.order ?? 1e9));
  const lines = [
    "# 自动化策略规则命中率",
    "",
    `搜索 ${file.searches} 次，找到证明 ${file.proved} 次${file.updated ? `（更新于 ${file.updated}）` : ""}。`,
    "",
    "| 规则 | 类型 | 说明 | 尝试 | 成功 | 成功率 | 进入证明 | 出现于搜索 |",
    "|---|---|---|---:|---:|---:|---:|---:|",
  ];
  for (const id of ids) {
    const c = own(file.rules, id) ?? { tried: 0, worked: 0, proofs: 0, searches: 0 };
    const d = docs.get(id);
    lines.push(`| \`${id}\` | ${d ? (d.kind === "finisher" ? "收尾" : "拆分") : "（已删除）"} | ${(d?.doc ?? "").replace(/\|/g, "\\|")} | ${c.tried} | ${c.worked} | ${pct(c.worked, c.tried)} | ${c.proofs} | ${c.searches} |`);
  }
  return lines.join("\n") + "\n";
}
