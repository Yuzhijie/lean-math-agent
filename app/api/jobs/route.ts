import { NextResponse } from "next/server";
import { listJobs } from "@/lib/jobs";
import { requestOwner } from "@/lib/bank/http";

export const dynamic = "force-dynamic";

/** The caller's solve jobs (running, queued with their place, recently ended). */
export async function GET() {
  return NextResponse.json({ jobs: listJobs(await requestOwner()) });
}
