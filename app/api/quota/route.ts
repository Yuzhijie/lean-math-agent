import { NextResponse } from "next/server";
import { requestOwner } from "@/lib/bank/http";
import { quotaStatus } from "@/lib/quota";

export const dynamic = "force-dynamic";

/** The caller's plan and what is used of it (solves this month, spend today). */
export async function GET() {
  return NextResponse.json(await quotaStatus(await requestOwner()));
}
