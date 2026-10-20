/**
 * Node runtime only (imported by instrumentation.ts): a fatal configuration problem stops the
 * process — Next only logs an error thrown from register() and keeps serving, which would run a
 * misconfigured server.
 */
import { runStartupChecks } from "./lib/startup-checks";

export async function registerNode(): Promise<void> {
  try {
    await runStartupChecks();
  } catch (e) {
    console.error(`[startup] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
