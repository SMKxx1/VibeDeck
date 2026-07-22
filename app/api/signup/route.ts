import { NextResponse } from "next/server";
import { AUTH_COOKIE, SESSION_MAX_AGE, createSessionToken } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/csrf";
import { signupWithInvite, checkLoginRateLimit } from "@/lib/users";
import { hashPassword } from "@/lib/password";
import { checkPublicRateLimit } from "@/lib/request-security";

// Signup (Phase 4): invite-only. The role is taken from the invite ROW server-side
// (never the request body), and the whole thing is atomic (see signupWithInvite):
// lock the invite, create the user, mark the invite used — all-or-nothing, so a
// token can't be redeemed twice and a failure never leaves a half-created user.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIN_PASSWORD = 12;
const MAX_PASSWORD = 200;

interface Body {
  token?: string;
  email?: string;
  password?: string;
  // NOTE: a `role` in the body is IGNORED — role comes from the invite.
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
  const token = (body.token ?? "").toString();
  const email = (body.email ?? "").toString().trim().toLowerCase();
  const password = (body.password ?? "").toString();

  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) {
    return NextResponse.json({ error: "invalid_invite" }, { status: 400 });
  }
  if (!email || !email.includes("@") || email.length > 320) {
    return NextResponse.json({ error: "invalid_email" }, { status: 400 });
  }
  if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
    return NextResponse.json({ error: "weak_password" }, { status: 400 });
  }

  const ingressLimit = await checkPublicRateLimit(req, "signup", "global", {
    max: 20,
    windowSeconds: 15 * 60,
  });
  if (!ingressLimit.allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  // Blunt abuse against a single invite token.
  if (!(await checkLoginRateLimit(`signup:${token}`))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  // Hash BEFORE the transaction so scrypt doesn't hold the invite row lock open.
  const passwordHash = await hashPassword(password);
  const result = await signupWithInvite({ token, email, passwordHash });
  if (!result.ok) {
    const status = result.error === "database_unavailable" ? 503 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }

  const res = NextResponse.json({ ok: true, role: result.role });
  res.cookies.set(AUTH_COOKIE, createSessionToken(result.userId, result.role), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  return res;
}
