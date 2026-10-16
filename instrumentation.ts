/**
 * Runs once when the server starts: configuration checks for a server other people use
 * (lib/startup-checks.ts). A fatal problem stops the process — Next only logs an error thrown
 * here and keeps serving, which would run a misconfigured server.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { runStartupChecks } = await import("./lib/startup-checks");
  try {
    await runStartupChecks();
  } catch (e) {
    console.error(`[startup] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
