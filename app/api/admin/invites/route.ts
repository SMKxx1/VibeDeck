import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, getSession, type Session } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/csrf";
import { createInvite, listInvites, revokeInvite, type Role } from "@/lib/users";

// Invite management — ADMIN ONLY (Phase 4). Uses getSession().role (NOT the
// boolean verifySessionToken, which accepts any presenter). Mints, lists, and
// revokes invites; the signup role is fixed at mint time and read from the invite
// row at redemption, so a presenter can never self-escalate.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Returns the admin session, or a Response to send (401 unauth / 403 not-admin).
async function requireAdmin(): Promise<Session | Response> {
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  const s = getSession(token);
  if (!s) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (s.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return s;
}

export async function GET() {
  const admin = await requireAdmin();
  if (admin instanceof Response) return admin;
  return NextResponse.json({ invites: await listInvites() });
}

interface PostBody {
  role?: unknown;
  email?: unknown;
}

export async function POST(req: Request) {
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const admin = await requireAdmin();
  if (admin instanceof Response) return admin;

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  // Only these two roles; anything else falls back to the least-privileged one.
  const role: Role = body.role === "admin" ? "admin" : "presenter";
  const email =
    typeof body.email === "string" && body.email.trim() ? body.email.trim().slice(0, 320) : null;

  const result = await createInvite(role, email, admin.userId);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 503 });
  return NextResponse.json(
    { token: result.token, url: `/signup?token=${result.token}`, role },
    { status: 201 },
  );
}

export async function DELETE(req: Request) {
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const admin = await requireAdmin();
  if (admin instanceof Response) return admin;

  const token = new URL(req.url).searchParams.get("token") ?? "";
  if (!token) return NextResponse.json({ error: "missing_token" }, { status: 400 });
  const result = await revokeInvite(token);
  return result.ok
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: result.error }, { status: 404 });
}
