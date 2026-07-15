// Telegram admin notify/approval channel (server-only). Telegram is NOT a
// sign-in method: it is how the OWNER hears about a new account request and
// approves/rejects it with one tap. Everything here is best-effort — when
// TELEGRAM_BOT_TOKEN / TELEGRAM_ADMIN_CHAT_ID are unset (both optional, read at
// CALL time, never at import/build time) or the API is down, the request row is
// already safely persisted and decidable from the admin view, so nothing throws
// on the degrade path.
//
// SECURITY — the inline buttons' callback_data is HMAC-signed with the SAME
// sign()/AUTH_SECRET construction as the session/preview tokens (lib/auth.ts):
// even if the bot token leaks, a forged callback can't approve anything because
// the webhook only acts on a callback_data whose signature verifies. Format
// (Telegram caps callback_data at 64 BYTES, so this is compact by design):
//
//   v1.<a|r>.<requestId>.<sig>
//
// where sig = the first 22 base64url chars (128 bits) of HMAC-SHA256 over the
// domain-separated string "tgcb:v1.<a|r>.<requestId>". 128-bit truncated
// HMAC-SHA256 is standard practice and leaves 2^64+ security against forgery;
// with a 24-char randomId the total is 52 bytes. The "tgcb:" prefix (with ':'
// and '.', both outside the base64url alphabet) means this payload can never be
// confused with the pure-base64url JSON payloads the session/preview tokens sign.

import crypto from "crypto";
import { sign } from "./auth";
import { setNotifyRefs, type AccountRequest } from "./account-requests";

const API_BASE = "https://api.telegram.org";

export type CallbackAction = "allow" | "reject";

const CB_VERSION = "v1";
const CB_SIG_CHARS = 22; // 128 bits of base64url HMAC-SHA256
const CB_MAX_BYTES = 64; // Telegram's hard callback_data limit

function config(): { token: string; chatId: string } | null {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
  if (!token || !chatId) return null;
  return { token, chatId };
}

// One-shot "not configured" signal, mirroring lib/db's logDbUnreachableOnce:
// silence after the first notice, never a throw.
let unconfiguredLogged = false;
function logUnconfiguredOnce(): void {
  if (unconfiguredLogged) return;
  unconfiguredLogged = true;
  console.log(
    "[telegram] TELEGRAM_BOT_TOKEN / TELEGRAM_ADMIN_CHAT_ID not set — account requests are persisted but no Telegram ping is sent (approve them from the admin view)",
  );
}

function cbSig(act: "a" | "r", rid: string): string {
  return sign(`tgcb:${CB_VERSION}.${act}.${rid}`).slice(0, CB_SIG_CHARS);
}

/** Build the signed callback_data for one button. Exported for tests/webhook symmetry. */
export function buildCallbackData(requestId: string, act: CallbackAction): string {
  const a = act === "allow" ? "a" : "r";
  return `${CB_VERSION}.${a}.${requestId}.${cbSig(a, requestId)}`;
}

/**
 * Verify a callback_data string from a webhook update: exact shape, then
 * timing-safe HMAC check (signature FIRST — same discipline as
 * verifyPreviewToken: bind the token cryptographically before trusting any
 * claim inside it). Returns the bound {rid, act} or null. Never throws.
 */
export function verifyCallbackData(
  data: string | undefined | null,
): { rid: string; act: CallbackAction } | null {
  if (!data || data.length > CB_MAX_BYTES * 2) return null; // cheap junk gate
  const parts = data.split(".");
  if (parts.length !== 4 || parts[0] !== CB_VERSION) return null;
  const [, a, rid, sig] = parts;
  if ((a !== "a" && a !== "r") || !rid || !sig) return null;
  let expected: string;
  try {
    expected = cbSig(a, rid); // secret() may throw in prod without AUTH_SECRET
  } catch {
    return null;
  }
  const x = Buffer.from(sig);
  const y = Buffer.from(expected);
  if (x.length !== y.length || !crypto.timingSafeEqual(x, y)) return null;
  return { rid, act: a === "a" ? "allow" : "reject" };
}

// Minimal shape of a Telegram Bot API response we care about.
interface TgResponse {
  ok?: boolean;
  result?: { message_id?: number; chat?: { id?: number | string } };
  description?: string;
}

async function tgPost(token: string, method: string, body: unknown): Promise<TgResponse | null> {
  const res = await fetch(`${API_BASE}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json().catch(() => null)) as TgResponse | null;
}

/**
 * Ping the admin chat about a new account request, with signed Approve/Reject
 * inline buttons, then remember the sent message's chat+message id (via
 * setNotifyRefs) so the webhook can edit it to ✅/❌ later. Best-effort
 * throughout: unset env → one log + return; API failure → log + return. The
 * request row is already persisted before this is called, so nothing is lost.
 */
export async function notifyAccountRequest(request: AccountRequest): Promise<void> {
  const cfg = config();
  if (!cfg) {
    logUnconfiguredOnce();
    return;
  }
  try {
    const allowData = buildCallbackData(request.id, "allow");
    const rejectData = buildCallbackData(request.id, "reject");
    // Defensive: with our 24-char randomId ids this is 52 bytes, but a future
    // longer id would make Telegram reject the whole sendMessage — catch it here.
    if (allowData.length > CB_MAX_BYTES || rejectData.length > CB_MAX_BYTES) {
      console.error("[telegram] callback_data exceeds 64 bytes — skipping buttons is not supported; not notifying");
      return;
    }
    const who = request.name ? `${request.name} <${request.email}>` : request.email;
    const body = await tgPost(cfg.token, "sendMessage", {
      chat_id: cfg.chatId,
      text: `New VibeDeck account request\n\n${who}\nvia ${request.provider}\n\nApprove to provision a presenter account.`,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Approve", callback_data: allowData },
            { text: "❌ Reject", callback_data: rejectData },
          ],
        ],
      },
    });
    if (body?.ok && body.result?.message_id != null && body.result.chat?.id != null) {
      await setNotifyRefs(request.id, String(body.result.chat.id), String(body.result.message_id));
    } else {
      console.error("[telegram] sendMessage failed:", body?.description ?? "no/invalid response");
    }
  } catch (err) {
    console.error("[telegram] notifyAccountRequest failed:", err);
  }
}

/**
 * Rewrite the original approval message (✅ approved / ❌ rejected) so the chat
 * reflects the outcome and the buttons disappear (editMessageText without
 * reply_markup drops the keyboard). Best-effort: failures are logged, never thrown.
 */
export async function editApprovalMessage(
  chatId: string,
  messageId: string,
  text: string,
): Promise<void> {
  const cfg = config();
  if (!cfg) return;
  try {
    const body = await tgPost(cfg.token, "editMessageText", {
      chat_id: chatId,
      message_id: Number(messageId),
      text,
    });
    if (!body?.ok) {
      console.error("[telegram] editMessageText failed:", body?.description ?? "no/invalid response");
    }
  } catch (err) {
    console.error("[telegram] editApprovalMessage failed:", err);
  }
}

/**
 * Acknowledge a callback query (stops the button's spinner; optional toast
 * text). Best-effort: failures are logged, never thrown.
 */
export async function answerCallback(callbackQueryId: string, text?: string): Promise<void> {
  const cfg = config();
  if (!cfg) return;
  try {
    const body = await tgPost(cfg.token, "answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    });
    if (!body?.ok) {
      console.error("[telegram] answerCallbackQuery failed:", body?.description ?? "no/invalid response");
    }
  } catch (err) {
    console.error("[telegram] answerCallback failed:", err);
  }
}
