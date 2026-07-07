import { NextResponse } from "next/server";
import { isDbReachable } from "@/lib/db";

// Liveness probe for the optional Postgres backing per-slide metadata. Ops/
// monitoring hits this with no auth, so it must never leak the connection
// string, host, or any env value — it returns only a coarse status. Three
// states: "not_configured" (no DATABASE_URL — a normal local/low-tier state,
// not an error), "ok" (configured and answering), "unreachable" (configured
// but down — the incident case that read paths otherwise hide). Kept minimal.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ status: "not_configured" }, { status: 200 });
  }
  if (await isDbReachable()) {
    return NextResponse.json({ status: "ok" }, { status: 200 });
  }
  return NextResponse.json({ status: "unreachable" }, { status: 503 });
}
