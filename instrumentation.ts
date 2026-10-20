/**
 * Runs once when the server starts: configuration checks for a server other people use
 * (lib/startup-checks.ts, run from instrumentation-node.ts). Next also compiles this file for the
 * Edge runtime, so Node-only code (process.exit) lives in the Node-only module imported below.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNode } = await import("./instrumentation-node");
    await registerNode();
  }
}
