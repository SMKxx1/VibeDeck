import { NextResponse } from "next/server";
import { AUTH_COOKIE } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/csrf";

// Presenter sign-out — clear the session cookie.

export const runtime = "nodejs";

export async function POST(req: Request) {
  // CSRF: reject a browser-attested cross-origin request first (see lib/csrf.ts).
  // Forcing a logout is very low-stakes, but including the check keeps every
  // state-changing presenter endpoint uniform — no exceptions to reason about.
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
