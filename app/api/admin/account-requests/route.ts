import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, getSession, type Session } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/csrf";
import { listPending, getRequest } from "@/lib/account-requests";
import { approveRequest, rejectRequest } from "@/lib/provision";
import { editApprovalMessage } from "@/lib/telegram";

// Account-request review — ADMIN ONLY. The no-Telegram (and Telegram-down)
// path for the same decisions the webhook makes: GET lists pending requests,
// POST {id, action} approves/rejects one. Both funnel into lib/provision, so
// the idempotency + provisioning invariants live in exactly one place — an
// admin here and a Telegram tap racing each other still yields one decision.
// Same gate pattern as app/api/admin/invites.

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
  return NextResponse.json({ requests: await listPending() });
}

interface PostBody {
  id?: unknown;
  action?: unknown;
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
  const id = typeof body.id === "string" ? body.id : "";
  const action = body.action === "allow" || body.action === "reject" ? body.action : null;
  if (!id || !action) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  // Audit label: the deciding admin's user id, or the legacy-admin marker (a
  // pre-accounts cookie has no user row — see lib/auth getSession).
  const decidedBy = admin.userId ?? "admin";

  // Fetch BEFORE deciding so we still have the notify refs/email for the
  // best-effort Telegram message edit below (fail-open read).
  const request = await getRequest(id);

  if (action === "allow") {
    const result = await approveRequest(id, decidedBy);
    if (!result.ok) {
      if (result.already) return NextResponse.json({ error: "already_decided" }, { status: 409 });
      if (result.error === "not_found") return NextResponse.json({ error: "not_found" }, { status: 404 });
      return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
    }
    // Keep the Telegram chat honest when the ping message exists: edit it to
    // the outcome so its buttons disappear. Best-effort — never blocks the 200.
    if (request?.notifyChatId && request.notifyMessageId) {
      await editApprovalMessage(request.notifyChatId, request.notifyMessageId, `✅ Approved ${request.email}`);
    }
    return NextResponse.json({ ok: true, userId: result.userId, role: result.role });
  }

  const result = await rejectRequest(id, decidedBy);
  if (!result.ok) return NextResponse.json({ error: "already_decided" }, { status: 409 });
  if (request?.notifyChatId && request.notifyMessageId) {
    await editApprovalMessage(request.notifyChatId, request.notifyMessageId, `❌ Rejected ${request.email}`);
  }
  return NextResponse.json({ ok: true });
}
