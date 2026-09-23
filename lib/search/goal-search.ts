/**
 * Goal-level best-first proof search on the Lean REPL (tactic mode).
 *
 * A node is a proof state (its remaining goals). Expanding a node first
 * runs the automation hammer on its goal, then asks the prover for k
 * candidate tactics, applies each one (milliseconds, incremental), keeps
 * one child per distinct resulting goal list, and scores children by how
 * many goals remain and how deep they are. The search stops at the first
 * state with no goals, when the node/time budget is spent, or when the
 * frontier is empty.
 *
 * The returned tactic script is only a candidate: callers re-assemble and
 * verify it with `verifyLeanSource` (statement lock, axioms) before a
 * proof counts.
 */
import { hammer, type HammerOutcome } from "../lean/hammer";
import { formatPremises, premisesEnabled, retrievePremises } from "../lean/premises";
import type { ProofSession } from "../lean/proof-state";
import { sampleText } from "../llm/client";
import { TACTIC_STEP_SYSTEM, tacticStepUserMessage } from "../llm/prompts";
import { PriorityQueue } from "./priority-queue";

export interface GoalSearchConfig {
  /** Tactic candidates sampled per expansion (GOAL_SEARCH_SAMPLES, default 4). */
  samplesPerNode: number;
  /** Max node expansions (GOAL_SEARCH_MAX_NODES, default 60). */
  maxNodes: number;
  /** Max proof depth in tactics (GOAL_SEARCH_MAX_DEPTH, default 20). */
  maxDepth: number;
  /** Frontier size kept (GOAL_SEARCH_BEAM, default 16). */
  beam: number;
  /** Wall-clock budget (GOAL_SEARCH_BUDGET_MS, default 120 s). */
  timeBudgetMs: number;
  /** Run the hammer at every node before sampling (default true). */
  useHammer: boolean;
  useMathlib: boolean;
  /** Sampling temperature for tactic candidates (default 0.8). */
  temperature: number;
  /** Retrieve premises for the current goal at every node (GOAL_SEARCH_RETRIEVE, default true). */
  retrieve: boolean;
}

export function loadGoalSearchConfig(overrides: Partial<GoalSearchConfig> = {}): GoalSearchConfig {
  const num = (name: string, dflt: number) => {
    const raw = process.env[name];
    const v = Number(raw);
    return raw !== undefined && raw !== "" && Number.isFinite(v) ? v : dflt;
  };
  return {
    samplesPerNode: Math.max(1, Math.floor(overrides.samplesPerNode ?? num("GOAL_SEARCH_SAMPLES", 4))),
    maxNodes: Math.max(1, Math.floor(overrides.maxNodes ?? num("GOAL_SEARCH_MAX_NODES", 60))),
    maxDepth: Math.max(1, Math.floor(overrides.maxDepth ?? num("GOAL_SEARCH_MAX_DEPTH", 20))),
    beam: Math.max(1, Math.floor(overrides.beam ?? num("GOAL_SEARCH_BEAM", 16))),
    timeBudgetMs: overrides.timeBudgetMs ?? num("GOAL_SEARCH_BUDGET_MS", 120_000),
    useHammer: overrides.useHammer ?? process.env.GOAL_SEARCH_HAMMER !== "false",
    useMathlib: overrides.useMathlib ?? true,
    temperature: overrides.temperature ?? num("GOAL_SEARCH_TEMPERATURE", 0.8),
    retrieve: overrides.retrieve ?? (process.env.GOAL_SEARCH_RETRIEVE !== "false" && premisesEnabled()),
  };
}

export interface GoalSearchProgress {
  expansions: number;
  frontier: number;
  depth: number;
  goals: number;
  detail: string;
}

export interface GoalSearchResult {
  ok: boolean;
  /** Tactic script (one tactic per line) that closed the root goal. */
  tactics?: string[];
  /** Final state handle in the session (when ok). */
  state?: number;
  expansions: number;
  llmCalls: number;
  tacticsTried: number;
  hammerHits: number;
  log: string;
  durationMs: number;
}

export interface GoalSearchArgs {
  session: ProofSession;
  /** State handle to start from (a hole of the session). */
  rootState: number;
  theoremName: string;
  theoremType: string;
  problemText?: string;
  /** Prompt block with retrieved premises / similar proofs (optional). */
  premises?: string;
  config?: Partial<GoalSearchConfig>;
  onProgress?: (p: GoalSearchProgress) => void;
}

interface Node {
  state: number;
  goals: string[];
  depth: number;
  score: number;
  failed: string[];
}

/** Identity of a goal list: hypotheses and targets, ignoring `case` labels and spacing. */
function goalsKey(goals: string[]): string {
  return goals
    .map((g) =>
      g
        .split("\n")
        .filter((l) => !/^case\b/.test(l.trim()))
        .join("\n")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .join(" ‖ ");
}

function scoreNode(goals: string[], depth: number): number {
  const size = goals.reduce((n, g) => n + g.length, 0);
  return goals.length + depth * 0.05 + Math.min(size, 4000) / 8000;
}

/** Turn a sampled completion into one tactic-mode command, or undefined. */
export function extractTactic(text: string): string | undefined {
  let body = text.replace(/\r/g, "").trim();
  const fence = body.match(/```[^\n]*\n([\s\S]*?)```/);
  if (fence) body = fence[1].trim();
  const lines = body
    .split("\n")
    .map((l) => l.replace(/^\s*(?:-\s+|\d+\.\s+)?/, "").trim())
    .filter((l) => l && !l.startsWith("--") && !/^(next tactic|tactic)\s*:/i.test(l));
  if (lines.length === 0) return undefined;
  let tactic = lines[0].replace(/^`+|`+$/g, "").replace(/^by\s+/, "").trim();
  if (lines.length > 1 && lines.every((l) => !/^[·|]/.test(l) && !/\bwith\s*$/.test(l))) {
    // Several plain tactics: run them in sequence as one command.
    tactic = `(${lines.map((l) => l.replace(/^`+|`+$/g, "").replace(/^by\s+/, "")).join("; ")})`;
  }
  if (/\b(sorry|admit)\b/.test(tactic)) return undefined;
  return tactic || undefined;
}

export async function goalSearch(args: GoalSearchArgs): Promise<GoalSearchResult> {
  const cfg = loadGoalSearchConfig(args.config);
  const { session } = args;
  const started = Date.now();
  const log: string[] = [];
  let expansions = 0;
  let llmCalls = 0;
  let tacticsTried = 0;
  let hammerHits = 0;
  const timeLeft = () => cfg.timeBudgetMs - (Date.now() - started);

  const rootGoals = session.goals(args.rootState);
  if (rootGoals.length === 0) {
    return { ok: true, tactics: [], state: args.rootState, expansions, llmCalls, tacticsTried, hammerHits, log: "root has no goals", durationMs: 0 };
  }

  const queue = new PriorityQueue<Node>((a, b) => a.score - b.score);
  const seen = new Set<string>([goalsKey(rootGoals)]);
  queue.push({ state: args.rootState, goals: rootGoals, depth: 0, score: scoreNode(rootGoals, 0), failed: [] });

  const done = (partial: Partial<GoalSearchResult>): GoalSearchResult => ({
    ok: false,
    expansions,
    llmCalls,
    tacticsTried,
    hammerHits,
    log: log.join("\n"),
    durationMs: Date.now() - started,
    ...partial,
  });

  const pushChild = (parent: Node, state: number, goals: string[], viaTactic: string): boolean => {
    const key = goalsKey(goals);
    if (seen.has(key)) return false;
    seen.add(key);
    const depth = parent.depth + 1;
    if (depth > cfg.maxDepth) return false;
    queue.push({ state, goals, depth, score: scoreNode(goals, depth), failed: [] });
    queue.prune(cfg.beam);
    log.push(`  + child via \`${viaTactic}\` → ${goals.length} goal(s)`);
    return true;
  };

  while (queue.size > 0) {
    if (expansions >= cfg.maxNodes) {
      log.push(`stop: ${cfg.maxNodes} expansions`);
      break;
    }
    if (timeLeft() <= 0) {
      log.push("stop: time budget");
      break;
    }
    const node = queue.pop()!;
    expansions++;
    log.push(`expand #${expansions} depth ${node.depth}, ${node.goals.length} goal(s): ${node.goals[0]?.split("\n").pop()?.slice(0, 80)}`);
    args.onProgress?.({ expansions, frontier: queue.size, depth: node.depth, goals: node.goals.length, detail: `搜索节点 ${expansions}（深度 ${node.depth}，剩余 ${node.goals.length} 个 goal）` });

    // 1. Automation first.
    if (cfg.useHammer) {
      const h: HammerOutcome = await hammer(session, node.state, {
        useMathlib: cfg.useMathlib,
        budgetMs: Math.min(30_000, Math.max(2_000, timeLeft())),
      });
      tacticsTried += h.attempts.length;
      if (h.solved && h.tactic !== undefined && h.state !== undefined) {
        hammerHits++;
        log.push(`  hammer closed it with \`${h.tactic}\``);
        return done({ ok: true, tactics: [...session.path(node.state), h.tactic], state: h.state });
      }
      if (h.progressed) {
        hammerHits++;
        pushChild(node, h.progressed.state, h.progressed.goals, h.progressed.tactic);
      }
      node.failed.push(...h.attempts.filter((a) => !a.ok).map((a) => a.tactic).slice(0, 6));
    }
    if (timeLeft() <= 0) continue;

    // 2. Ask the prover for k tactics (with premises retrieved for this goal).
    let premises = args.premises;
    if (cfg.retrieve && cfg.useMathlib) {
      try {
        const block = formatPremises(await retrievePremises(node.goals[0], { k: 6, context: args.theoremType }));
        if (block) premises = premises ? `${premises}\n\n${block}` : block;
      } catch {
        // retrieval is best-effort
      }
    }
    let samples: string[] = [];
    try {
      samples = await sampleText({
        messages: [
          { role: "system", content: TACTIC_STEP_SYSTEM },
          {
            role: "user",
            content: tacticStepUserMessage({
              theoremName: args.theoremName,
              theoremType: args.theoremType,
              goals: node.goals,
              history: session.path(node.state),
              failed: node.failed,
              problemText: args.problemText,
              premises,
            }),
          },
        ],
        n: cfg.samplesPerNode,
        role: "prover",
        temperature: cfg.temperature,
        maxTokens: 512,
        timeoutMs: Math.max(20_000, Math.min(timeLeft(), 120_000)),
      });
      llmCalls += cfg.samplesPerNode;
    } catch (e) {
      log.push(`  llm failed: ${e instanceof Error ? e.message : String(e)}`);
      if (/LLM_API_KEY/.test(String(e instanceof Error ? e.message : e))) throw e;
      continue;
    }
    const tactics = [...new Set(samples.map(extractTactic).filter((t): t is string => !!t))].filter((t) => !node.failed.includes(t));
    for (const tactic of tactics) {
      if (timeLeft() <= 0) break;
      const r = await session.apply(node.state, tactic);
      tacticsTried++;
      if (!r.ok) {
        node.failed.push(tactic);
        log.push(`  ✗ \`${tactic}\`: ${r.error.split("\n")[0].slice(0, 100)}`);
        continue;
      }
      if (r.solved) {
        log.push(`  ✓ \`${tactic}\` closed the goal`);
        return done({ ok: true, tactics: [...session.path(node.state), tactic], state: r.state });
      }
      if (r.goals.length === 0) {
        // Closed with an admitted hole (`sorry` inside) — never accept.
        node.failed.push(tactic);
        continue;
      }
      pushChild(node, r.state, r.goals, tactic);
    }
  }
  if (queue.size === 0) log.push("stop: frontier exhausted");
  return done({});
}
