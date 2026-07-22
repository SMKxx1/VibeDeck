import { NextResponse } from "next/server";
import { AUTH_COOKIE, SESSION_MAX_AGE, createSessionToken } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/csrf";
import { getUserByEmail, verifyPassword, checkLoginRateLimit } from "@/lib/users";
import { DUMMY_HASH } from "@/lib/password";
import { checkPublicRateLimit } from "@/lib/request-security";

// Login (Phase 4): email/username + password against the users table (scrypt).
// The seeded admin's identifier is PRESENTER_USERNAME (may be a plain username,
// not an email), so `username` is accepted too. On success we mint a v:2 session
// carrying the user's id + role.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  username?: string;
  email?: string;
  password?: string;
}

export async function POST(req: Request) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const identifier = (body.email ?? body.username ?? "").toString().trim();
  const password = (body.password ?? "").toString();
  if (!identifier || identifier.length > 320 || !password || password.length > 200) {
    return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
  }

  const ingressLimit = await checkPublicRateLimit(req, "login", "global", {
    max: 30,
    windowSeconds: 5 * 60,
  });
  if (!ingressLimit.allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  // Rate-limit per identifier BEFORE scrypt — the hash cost must not be a DoS on
  // this unauthenticated endpoint, and this caps brute-force against one account.
  if (!(await checkLoginRateLimit(identifier.toLowerCase()))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  let user: Awaited<ReturnType<typeof getUserByEmail>>;
  try {
    user = await getUserByEmail(identifier);
  } catch {
    return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
  }
  // ALWAYS run scrypt — against a fixed dummy hash when the user is absent — so a
  // missing account costs the same as a real one (no user-enumeration timing
  // oracle). The dummy hash can never match a real password. The response is a
  // generic "invalid_credentials" either way (never reveal whether the email exists).
  const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok) {
    return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true, role: user.role });
  res.cookies.set(AUTH_COOKIE, createSessionToken(user.id, user.role), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  return res;
}
