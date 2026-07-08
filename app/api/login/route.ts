import { NextResponse } from "next/server";
import {
  AUTH_COOKIE,
  SESSION_MAX_AGE,
  checkPresenterCredentials,
  createSessionToken,
} from "@/lib/auth";
import { assertSameOrigin } from "@/lib/csrf";

// Presenter sign-in. On valid credentials, set the signed session cookie.

export const runtime = "nodejs";

interface Body {
  username?: string;
  password?: string;
}

export async function POST(req: Request) {
  // CSRF: reject a browser-attested cross-origin request first (see lib/csrf.ts).
  // Login CSRF is low-stakes here (no credential theft, just a nuisance session),
  // but the check is cheap and correct to include for completeness/consistency.
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const username = (body.username ?? "").toString();
  const password = (body.password ?? "").toString();

  if (!checkPresenterCredentials(username, password)) {
    return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE, createSessionToken(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  return res;
}
