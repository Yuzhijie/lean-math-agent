import { NextResponse } from "next/server";
import { bootId } from "@/lib/boot";

export const dynamic = "force-dynamic";

/** GET this server process's start id: the solver page restores its last view only within one run. */
export async function GET() {
  return NextResponse.json({ boot: bootId() }, { headers: { "Cache-Control": "no-store" } });
}
