import type { MathDomain, MethodOption, MethodScore } from "../types";
import { runStrategist, getStrategistConfigs } from "./strategist";
import { evaluateMethods } from "../llm/evaluate";

interface OrchestratorResult {
  methods: MethodOption[];
  scores: MethodScore[];
  recommended_method_id: string;
  comparison: string;
}

/**
 * Orchestrates parallel strategist agents and the critic evaluation.
 *
 * Flow:
 * 1. Select strategist configs based on domain
 * 2. Run all strategists in parallel
 * 3. Deduplicate methods (by title similarity)
 * 4. Pass to critic for 5-dimension scoring
 * 5. Return ranked methods with recommendation
 */
export async function runMultiAgentEvaluation(args: {
  problemText: string;
  formalStatement?: string;
  domain: MathDomain;
  maxConcurrent?: number;
}): Promise<OrchestratorResult> {
  const configs = getStrategistConfigs(args.domain);
  const concurrency = args.maxConcurrent ?? configs.length;

  // Run strategists in parallel (bounded by concurrency limit)
  const methodResults = await runParallelWithConcurrency(
    configs.map(
      (config) => () =>
        runStrategist(config, args.problemText, args.formalStatement),
    ),
    concurrency,
  );

  // Flatten and deduplicate methods
  const allMethods = methodResults
    .filter((r): r is MethodOption[] => Array.isArray(r))
    .flat();
  const deduplicated = deduplicateMethods(allMethods);

  // Evaluate all methods with the critic
  const evaluation = await evaluateMethods({
    methods: deduplicated,
    problemText: args.problemText,
    formalStatement: args.formalStatement,
    domain: args.domain,
  });

  return {
    methods: deduplicated,
    scores: evaluation.scores,
    recommended_method_id: evaluation.recommended_method_id,
    comparison: evaluation.comparison,
  };
}

/**
 * Run tasks in parallel with a concurrency limit.
 */
async function runParallelWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  maxConcurrent: number,
): Promise<(T | null)[]> {
  const results: (T | null)[] = new Array(tasks.length).fill(null);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < tasks.length) {
      const idx = nextIndex++;
      try {
        results[idx] = await tasks[idx]();
      } catch {
        results[idx] = null; // graceful failure
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(maxConcurrent, tasks.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

/**
 * Simple deduplication: remove methods with very similar titles.
 */
function deduplicateMethods(methods: MethodOption[]): MethodOption[] {
  const seen = new Set<string>();
  return methods.filter((m) => {
    const key = m.title.toLowerCase().replace(/\s+/g, "_");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
