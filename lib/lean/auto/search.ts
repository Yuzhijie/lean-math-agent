/**
 * Automation search: an AND/OR search over tactic states with the tactic library of
 * tactics.ts, no model. To close the main goal: try every finisher (`· tac`, which must close
 * it); otherwise try a splitter, then close each goal it made, in order, recursively — and undo
 * the splitter when one of them resists. Goals already known to resist are not tried again.
 * The applied tactics form a linear script (each new goal is the main goal in turn), verified as
 * a whole by the caller.
 */
import { parseGoal } from "../geometry/goal";
import type { TacticRunner } from "../tactic-runner";
import { finishers, splitters, type Splitter } from "./tactics";
import { certificateTactic } from "./certificate";
import { linearValuesTactic } from "./linear";
import { isInaccessible } from "../geometry/goal";
import { topIndex } from "../combinatorics/lets";

export interface AutoOptions {
  maxDepth?: number;
  /** Stop starting new work after this time (ms since epoch). */
  deadline: number;
}

export interface AutoStats {
  tactics: number;
  splitters: Splitter["kind"][];
}

class OutOfTime extends Error {}

const norm = (g: string) => g.replace(/\s+/g, " ").replace(/^case \S+ /, "").trim();

export async function autoSearch(run: TacticRunner, opts: AutoOptions): Promise<{ ok: boolean; stats: AutoStats }> {
  const maxDepth = opts.maxDepth ?? 3;
  const failed = new Set<string>();
  const stats: AutoStats = { tactics: 0, splitters: [] };
  const apply = async (t: string) => {
    if (Date.now() > opts.deadline) throw new OutOfTime();
    stats.tactics++;
    return run.apply(t);
  };

  /** Close goals()[0]; the goals after it stay as they are. */
  async function solveMain(depth: number, seen: Set<string>): Promise<boolean> {
    const g = run.goals()[0];
    if (g === undefined) return true;
    const key = norm(g);
    if (failed.has(key) || seen.has(key)) return false;
    const st = parseGoal(g);
    if (!st) return false;
    const n0 = run.goals().length;
    for (const f of finishers(st)) {
      if ((await apply(`· ${f}`)) && run.goals().length === n0 - 1) return true;
    }
    // an equation that follows from the equation hypotheses: the coefficients computed exactly
    const cert = Date.now() < opts.deadline ? await certificateTactic(st, 8).catch(() => undefined) : undefined;
    if (cert && (await apply(`· ${cert}`)) && run.goals().length === n0 - 1) return true;
    if (depth < maxDepth) {
      const path = new Set(seen).add(key);
      const lin = linearValuesTactic(st, run.fresh);
      const steps = [...(lin ? [{ tactic: lin, kind: "rewrite" as const }] : []), ...splitters(st, run.fresh)];
      for (const sp of steps) {
        const mark = run.save();
        if (!(await apply(sp.tactic))) continue;
        const made = run.goals().length - (n0 - 1);
        if (made <= 0) {
          stats.splitters.push(sp.kind);
          return true;
        }
        if (made === 1 && norm(run.goals()[0]) === key) {
          run.restore(mark);
          continue;
        }
        let ok = true;
        for (let i = 0; i < made && ok; i++) ok = await solveMain(depth + 1, path);
        if (ok) {
          stats.splitters.push(sp.kind);
          return true;
        }
        run.restore(mark);
      }
    }
    failed.add(key);
    return false;
  }

  /** Binders introduced and ∧ / ∃ hypotheses taken apart once, before the search (not a level of it). */
  async function normalize(): Promise<void> {
    for (let i = 0; i < 30 && run.goals().length; i++) {
      const st = parseGoal(run.goals()[0]);
      if (!st) return;
      const t = st.target.trim();
      const all = /^∀ \(?([A-Za-z_][\w'₀-₉]*)/.exec(t);
      if (all && !st.hyps.some((h) => h.names.includes(all[1])) && (await apply(`intro ${all[1]}`))) continue;
      if ((/^∀/.test(t) || (topIndex(t, "→") >= 0 && !/^¬/.test(t))) && (await apply(`intro ${run.fresh("h")}`))) continue;
      const h = st.hyps.find((x) => x.names.length === 1 && !isInaccessible(x.names[0]) && !/^∀/.test(x.type.trim()) && (/^∃/.test(x.type.trim()) || topIndex(x.type, " ∧ ") >= 0));
      if (h && (await apply(`obtain ⟨${run.fresh("h")}, ${run.fresh("h")}⟩ := ${h.names[0]}`))) continue;
      return;
    }
  }

  try {
    await normalize();
    const ok = await solveMain(0, new Set());
    return { ok: ok && run.goals().length === 0, stats };
  } catch (e) {
    if (e instanceof OutOfTime) return { ok: false, stats };
    throw e;
  }
}
