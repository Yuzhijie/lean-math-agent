import { lt } from "../llm/output-locale";
import type { TimeLimitError } from "../jobs";

/** What the user is told when a solve hit SOLVE_TIME_LIMIT_MIN. */
export function timeLimitMessage(e: TimeLimitError): string {
  const min = Math.round(e.limitMs / 60_000);
  return lt(
    `求解超过 ${min} 分钟的时间上限，已停止（本地证明模型很慢时最常见）。可以再试一次，或在 .env.local 里调整 SOLVE_TIME_LIMIT_MIN（0 = 不限时）`,
    `The solve passed its ${min}-minute time limit and was stopped (most often when a local prover model is slow). Try again, or change SOLVE_TIME_LIMIT_MIN in .env.local (0 = no limit)`,
  );
}
