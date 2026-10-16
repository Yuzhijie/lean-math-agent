/**
 * Health check for the load balancer / docker healthcheck (public, says nothing secret):
 * 200 when the configuration is sound and Lean is available, 503 otherwise.
 */
import { NextResponse } from "next/server";
import { checkLeanAvailable } from "@/lib/lean/sandbox";
import { startupReport } from "@/lib/startup-checks";

export const dynamic = "force-dynamic";

async function computeReachable(): Promise<boolean | undefined> {
  const url = process.env.COMPUTE_ENGINE_URL;
  if (!url) return undefined;
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/evaluate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expression: "1+1" }),
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function GET() {
  const [lean, report, compute] = await Promise.all([checkLeanAvailable(), startupReport().catch(() => ({ fatal: ["check failed"], warn: [] })), computeReachable()]);
  const ok = lean.ok && report.fatal.length === 0 && compute !== false;
  return NextResponse.json(
    { ok, lean: lean.ok, compute: compute ?? "not configured", config: report.fatal.length === 0, warnings: report.warn.length },
    { status: ok ? 200 : 503 },
  );
}
