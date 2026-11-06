/**
 * The tactic library of the automation search, as lists: finishers (close the goal or fail) and
 * splitters (turn it into simpler goals), ordered cheap and likely first. The library itself is
 * the rule table of rules.ts — one entry per strategy; this module keeps the flat lists.
 */
import type { GoalState } from "../geometry/goal";
import { finisherEntries, splitterEntries, type Splitter } from "./rules";

export type { Splitter } from "./rules";
export { boundedVars, defInstances, denominators, firstAbs, gcdLcm, goalText, sqrtArgs } from "./helpers";

export function finishers(st: GoalState): string[] {
  return finisherEntries(st).map((e) => e.tactic);
}

export function splitters(st: GoalState, fresh: (base: string) => string): Splitter[] {
  return splitterEntries(st, fresh);
}
