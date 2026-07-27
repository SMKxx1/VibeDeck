// THE single OpenRouter entry point. Every AI feature calls the model through
// here (the tutor's SSE path uses the low-level pieces; the nine JSON features
// use callModel), so the platform-key discipline lives in exactly one file:
// the 4 standard headers, the abort-on-timeout bound, the reasoning-400 retry,
// and the token accounting (recordTokens + recordBudgetTokens) that reconciles
// the daily budget reservation. PRIVACY (slide-system-rules.md §9): nothing
// here ever logs or persists a prompt or an answer — failure logs carry only
// the upstream status, request id, and the upstream error body's first bytes.
//
// What deliberately does NOT live here: the per-route gate ORDER (same-origin,
// rate-limit bucket, budget reservation, key-configured 503). Routes interleave
// those with their own auth/publish/grounding gates in an order that is part of
// their security contract — e.g. /api/portfolio checks the key BEFORE reserving
// budget so a keyless deploy can't leak reservations. callModel assumes the
// caller has already passed its own gates.

import { recordTokens, recordBudgetTokens } from "./kv";

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
export const DEFAULT_MODEL = "deepseek/deepseek-v4-flash";

/** The one fetch every OpenRouter call goes through — 4 standard headers. */
export function openRouterFetch(
  payload: Record<string, unknown>,
  opts: { apiKey: string; signal?: AbortSignal },
): Promise<Response> {
  return fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.OPENROUTER_SITE_URL ?? "",
      "X-Title": process.env.OPENROUTER_SITE_NAME ?? "VibeDeck",
    },
    body: JSON.stringify(payload),
    signal: opts.signal,
  });
}

/**
 * Not every model lets you tune reasoning — some hybrids reject the
 * `reasoning` param with a 400. Rather than fail the whole request, retry once
 * without the field (mutating `payload`, matching the historical call sites).
 * A 400 that is NOT reasoning-related comes back with its body already read;
 * `badRequestDetail` carries that text so the caller can log it (the Response
 * body cannot be read twice).
 */
export async function callWithReasoningRetry(
  payload: Record<string, unknown>,
  fetchFn: (p: Record<string, unknown>) => Promise<Response>,
): Promise<{ res: Response; badRequestDetail: string | null }> {
  let res = await fetchFn(payload);
  let badRequestDetail: string | null = null;
  if (res.status === 400 && payload.reasoning) {
    const detail = await res.text().catch(() => "");
    if (/reasoning/i.test(detail)) {
      delete payload.reasoning;
      res = await fetchFn(payload);
    } else {
      badRequestDetail = detail;
    }
  }
  return { res, badRequestDetail };
}

export type ModelResult =
  | { ok: true; content: string; tokens: number; finishReason?: string }
  | { ok: false; error: "upstream_error" | "timeout" | "request_failed" };

/**
 * One non-streaming model call: timeout → fetch → reasoning retry → parse →
 * token accounting. Returns a discriminated result so each route maps failures
 * to its OWN response contract (a hard 502/504, a silent empty payload, …) —
 * this helper never decides HTTP behavior.
 *
 * - `tag` prefixes failure logs (status + request id only, never content).
 * - `tokenLabel` is the recordTokens bucket — `u:<name>` for viewer-attributed
 *   spend, a feature name ("recap", "quizdraft", …) for presenter features.
 * - `content` is returned exactly as the provider sent it (callers trim).
 */
export async function callModel(opts: {
  tag: string;
  payload: Record<string, unknown>;
  tokenLabel: string;
  timeoutMs?: number;
}): Promise<ModelResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return { ok: false, error: "request_failed" }; // routes gate 503 first

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 45_000);
  try {
    const { res, badRequestDetail } = await callWithReasoningRetry(opts.payload, (p) =>
      openRouterFetch(p, { apiKey, signal: controller.signal }),
    );
    if (!res.ok) {
      const detail = badRequestDetail ?? (await res.text().catch(() => ""));
      console.error(`[${opts.tag}] OpenRouter request failed`, {
        status: res.status,
        requestId: res.headers.get("x-request-id") ?? undefined,
        detail: detail.slice(0, 300),
      });
      return { ok: false, error: "upstream_error" };
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      usage?: { total_tokens?: number };
    };
    const tokens = Number(data.usage?.total_tokens ?? 0);
    await recordTokens(opts.tokenLabel, tokens); // PRIVACY: only { name, timestamp, count }
    await recordBudgetTokens(tokens);
    return {
      ok: true,
      content: data.choices?.[0]?.message?.content ?? "",
      tokens,
      finishReason: data.choices?.[0]?.finish_reason,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, error: "timeout" };
    }
    return { ok: false, error: "request_failed" };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Pull a single JSON object out of a model response that may be fenced or
 * padded with prose despite a strict-JSON instruction. Returns null when
 * nothing parseable — callers validate the object's actual shape themselves.
 */
export function parseFencedJson(raw: string): Record<string, unknown> | null {
  let t = raw.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const o = JSON.parse(t.slice(start, end + 1));
    return o && typeof o === "object" ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
