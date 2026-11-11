/**
 * Evaluation runs (`npm run e2e`): a solve started with the header `x-eval-run` must not teach the
 * system the problems it is being measured on. Inside this scope the proof memory, the repair
 * pairs and the learned tactic rules are read but never written (no new proof, no use count) —
 * otherwise the second run of a held-out set would replay the first run's proofs and the score
 * would measure memory, not the provers. The scope travels with the request (AsyncLocalStorage),
 * also into work a solve leaves running in the background.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export const EVAL_HEADER = "x-eval-run";

const scope = new AsyncLocalStorage<true>();

/** Run `fn` as an evaluation: memory and learned rules stay as they are. */
export function withEvalMode<T>(fn: () => T): T {
  return scope.run(true, fn);
}

/** Whether the current work belongs to an evaluation run. */
export function evalMode(): boolean {
  return scope.getStore() === true;
}

/** Run `fn` in evaluation mode when the request asks for it. */
export function withRequestEvalMode<T>(req: Request, fn: () => T): T {
  return req.headers.get(EVAL_HEADER) ? withEvalMode(fn) : fn();
}
