import crypto from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import { verifyCallbackData, answerCallback, editApprovalMessage } from "@/lib/telegram";
import { approveRequest, rejectRequest } from "@/lib/provision";
import { getRequest } from "@/lib/account-requests";

// Telegram approval webhook — the endpoint Telegram's servers POST button
// presses to. DELIBERATELY NOT presenter-gated: Telegram is not logged in, so
// the session cookie can't be its auth. Its auth is TWO independent layers:
//
//   1. X-Telegram-Bot-Api-Secret-Token — the secret chosen when registering the
//      webhook (setWebhook secret_token=...). Telegram echoes it on every
//      delivery; only a caller holding TELEGRAM_WEBHOOK_SECRET gets past this.
//      Unset env → 404: the route is inert until explicitly configured.
//   2. The callback_data itself is HMAC-signed (lib/telegram buildCallbackData,
//      keyed by AUTH_SECRET) binding {requestId, action} — so even a leaked bot
//      token / forged delivery cannot approve anything: verifyCallbackData
//      rejects any payload we didn't mint.
//
// Idempotency lives in approveRequest/rejectRequest (pending-only transition
// under FOR UPDATE): a double-tap reports "already decided" and provisions
// nothing. ALWAYS answers 200 once authenticated — Telegram retries non-200
// deliveries, and a retry storm on a decided request is pure noise.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Minimal shape of the update we act on.
interface TgUpdate {
  callback_query?: {
    id?: unknown;
    data?: unknown;
  };
}

function secretHeaderOk(req: NextRequest, expected: string): boolean {
  const got = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const OK = () => NextResponse.json({ ok: true });

export async function POST(req: NextRequest) {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) return new NextResponse(null, { status: 404 }); // unconfigured → inert
  if (!secretHeaderOk(req, expected)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let update: TgUpdate;
  try {
    update = (await req.json()) as TgUpdate;
  } catch {
    return OK(); // authenticated but malformed — swallow, don't invite retries
  }

  const cq = update.callback_query;
  if (!cq || typeof cq.id !== "string") return OK(); // not a button press — ignore

  try {
    const parsed = verifyCallbackData(typeof cq.data === "string" ? cq.data : null);
    if (!parsed) {
      await answerCallback(cq.id, "Invalid or expired button.");
      return OK();
    }

    // Read the request BEFORE deciding — we need its email + notify refs for
    // the message edit, and getRequest is fail-open (null on DB blip).
    const request = await getRequest(parsed.rid);

    if (parsed.act === "allow") {
      const result = await approveRequest(parsed.rid, "telegram");
      if (result.ok) {
        if (request?.notifyChatId && request.notifyMessageId) {
          await editApprovalMessage(
            request.notifyChatId,
            request.notifyMessageId,
            `✅ Approved ${request.email}`,
          );
        }
        await answerCallback(cq.id, "Approved — account provisioned.");
      } else if (result.already) {
        // The first tap already edited the message; just acknowledge.
        await answerCallback(cq.id, "Already decided.");
      } else {
        await answerCallback(cq.id, "Failed — try again.");
      }
    } else {
      const result = await rejectRequest(parsed.rid, "telegram");
      if (result.ok) {
        if (request?.notifyChatId && request.notifyMessageId) {
          await editApprovalMessage(
            request.notifyChatId,
            request.notifyMessageId,
            `❌ Rejected ${request.email}`,
          );
        }
        await answerCallback(cq.id, "Rejected.");
      } else {
        await answerCallback(cq.id, "Already decided.");
      }
    }
  } catch (err) {
    // Never let a fault turn into a non-200 (Telegram would retry the same
    // update at us in a loop); the decision helpers are idempotent anyway.
    console.error("[telegram-webhook] failed:", err);
  }
  return OK();
}
