import { existsSync } from "node:fs";
import path from "node:path";
import { checkLeanAvailable, sandboxRoot } from "@/lib/lean/sandbox";
import { defaultReplBinPath, replLauncherFromEnv } from "@/lib/lean/repl";

export interface LeanEnvStatus {
  /** `lake` runs (or a custom REPL launcher is configured). */
  lake: boolean;
  /** The REPL binary exists (server mode possible). */
  repl: boolean;
  /** Mathlib is present in the sandbox's packages. */
  mathlib: boolean;
  /**
   * The sandbox's dependencies have been fetched (`.lake/packages` exists),
   * so `lake env` works there. A machine with `lake` but an unbuilt sandbox
   * cannot verify anything.
   */
  sandboxReady: boolean;
  /** Core-Lean verification can run (REPL, custom launcher, or spawn in a ready sandbox). */
  canVerify: boolean;
}

/**
 * What the Lean environment on this machine can do. Integration tests skip
 * themselves based on this instead of failing where Lean/Mathlib are absent.
 */
export async function leanStatus(): Promise<LeanEnvStatus> {
  const root = sandboxRoot();
  const lake = (await checkLeanAvailable()).ok;
  const custom = !!replLauncherFromEnv();
  const repl = custom || existsSync(defaultReplBinPath(root));
  const mathlib = existsSync(path.join(root, ".lake", "packages", "mathlib"));
  const sandboxReady = custom || existsSync(path.join(root, ".lake", "packages"));
  return { lake, repl, mathlib, sandboxReady, canVerify: lake && (repl || sandboxReady) };
}
