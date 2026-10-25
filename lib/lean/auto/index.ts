/**
 * Entry point of the automation search (search.ts, strategy "auto"): open the statement in REPL
 * tactic mode, search, verify the script as a whole. Runs after the single-tactic hammer.
 */
import { CancelledError } from "../../jobs";
import type { LeanVerifyResult } from "../sandbox";
import { openRunner, scriptSource } from "../tactic-runner";
import { autoSearch, type AutoStats } from "./search";

export interface AutoProof {
  verification: LeanVerifyResult;
  source: string;
  tactics: string;
  stats: AutoStats;
}

export async function autoProof(args: {
  sessionId: string;
  theoremName: string;
  theoremType: string;
  expectedSignature?: string;
  useMathlib: boolean;
  opens?: string[];
  timeLimitMs?: number;
}): Promise<{ proof?: AutoProof; reason: string; stats?: AutoStats }> {
  const { sessionId, theoremName, theoremType, expectedSignature, useMathlib, opens } = args;
  const limit = args.timeLimitMs ?? Number(process.env.AUTO_TIME_LIMIT_MS ?? 60_000);
  const opened = await openRunner({
    theoremName,
    theoremType,
    useMathlib,
    opens,
    // the runner's own limit is a backstop; the search stops starting new work at its deadline
    timeLimitMs: limit + 30_000,
    tacticTimeoutMs: Number(process.env.AUTO_TACTIC_TIMEOUT_MS ?? 10_000),
    label: "auto",
    debugEnv: "AUTO_DEBUG",
  });
  if (typeof opened === "string") return { reason: opened };
  const { run, script, session } = opened;
  try {
    const { ok, stats } = await autoSearch(run, { deadline: Date.now() + limit, maxDepth: Number(process.env.AUTO_MAX_DEPTH ?? 3) });
    if (!ok) return { reason: `no combination closed every goal (${stats.tactics} tactics tried)`, stats };
    const tactics = script.join("\n");
    const source = scriptSource({ theoremName, theoremType, tactics, useMathlib, opens, heartbeats: Number(process.env.AUTO_MAX_HEARTBEATS ?? 1_000_000) });
    const verification = await session.verify(sessionId, source, { theoremName, expectedSignature });
    if (!verification.ok && process.env.AUTO_DEBUG) console.error(`[auto] verify failed:\n${source}\n${verification.log}`);
    if (!verification.ok) return { reason: `the script did not verify: ${verification.log.split("\n")[0]?.slice(0, 160) ?? ""}`, stats };
    return { proof: { verification, source, tactics, stats }, reason: "" };
  } catch (e) {
    if (e instanceof CancelledError) throw e;
    return { reason: e instanceof Error ? e.message.split("\n")[0] : String(e) };
  } finally {
    session.close();
  }
}
