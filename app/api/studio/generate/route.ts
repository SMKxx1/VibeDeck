import { cookies } from "next/headers";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/csrf";
import { checkRateLimit } from "@/lib/kv";

// BYO-key Studio generation proxy (Phase 3). The presenter brings their OWN
// OpenRouter key; this endpoint forwards a generation request to OpenRouter and
// streams the result back. The platform key (used by the viewer AI tutor) is
// never touched here — cost/quota stay the presenter's.
//
// KEY HYGIENE — the non-negotiable invariants (an leaked user API key is an
// incident):
//   • The key arrives in the `x-openrouter-key` REQUEST HEADER and is used in
//     EXACTLY ONE place: the upstream `Authorization` header below. It is never
//     written to the DB, never put into any object that gets JSON.stringify'd
//     into a response or a log, and never console.log'd. Railway's request logs
//     record method/path/status only, not headers — so the header path is clean.
//   • On an upstream error we log the STATUS ONLY, never the upstream body
//     (categorically avoids echoing anything key-adjacent).
//
// NOT AN OPEN RELAY / SSRF: the upstream URL and model are chosen SERVER-SIDE and
// never come from the request; only `prompt`/`currentHtml` are user-controlled and
// they only ever become message CONTENT. The route is presenter-gated + CSRF-checked.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// HARDCODED upstream — never from user input.
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const MAX_KEY = 400;
const MAX_PROMPT = 6000;
const MAX_HTML = 2_000_000; // an editable deck must be <= this to save anyway
const MAX_BODY = 2_200_000; // Content-Length ceiling checked BEFORE buffering

// The generation contract, restated cleanly for the model. Deliberately carries
// NO markdown-fenced examples (fenced examples make models wrap their output in
// fences) and explicitly forbids fences + commentary. Kept in sync with the
// Phase-2 validator (lib/deck-validator) and VIBEDECK_PROMPT.md.
const SYSTEM_PROMPT = [
  "You generate self-contained HTML presentation decks for the VibeDeck platform.",
  "Given a topic or an edit request, output ONE complete HTML document that follows these EXACT rules:",
  "",
  "STRUCTURE",
  "- A single <deck-stage width=\"1280\" height=\"720\"> element wraps all slides.",
  "- Each slide is a DIRECT <section> child of <deck-stage>. Never nest a slide <section> inside another.",
  "- Give every slide a data-label attribute with a short title (e.g. <section data-label=\"Introduction\">).",
  "- Optionally add data-speaker-notes=\"...\" to a slide for presenter notes.",
  "",
  "SELF-CONTAINED",
  "- All CSS and JavaScript must be INLINE (<style> and <script> tags, or inline style= attributes).",
  "- Do NOT use any external resources: no <script src>, no <link href> stylesheets, no external fonts, no <img src> to remote URLs (network requests are blocked). Use inline SVG or CSS for visuals.",
  "- Do NOT include any slide-engine/runtime script yourself — the platform injects the runtime automatically.",
  "",
  "LOOK",
  "- Each <section> should fill the 1280x720 stage. A good default: style each section with height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; padding:80px; and a pleasant background color. Use large, readable type.",
  "",
  "AI GROUNDING (recommended)",
  "- Include one manifest so the built-in AI tutor can answer questions: <script type=\"application/json\" id=\"vibedeck-context\">[{\"index\":0,\"label\":\"...\",\"aiContext\":\"one short paragraph describing what this slide teaches\"}, ...]</script> with one entry per slide (index is the 0-based slide number).",
  "",
  "OUTPUT",
  "- Output ONLY the raw HTML document, starting with <!doctype html>. Do NOT wrap it in markdown code fences. Do NOT add any explanation before or after. Just the HTML.",
].join("\n");

async function isPresenter(): Promise<boolean> {
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  return verifySessionToken(token);
}

function jsonError(error: string, status: number, extra?: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ error, ...extra }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface Body {
  prompt?: unknown;
  currentHtml?: unknown;
}

export async function POST(req: Request) {
  // Gate order (cheapest first): presenter (401) -> CSRF (403) -> size (413) ->
  // rate-limit (429) -> input validation.
  if (!(await isPresenter())) return jsonError("unauthorized", 401);
  if (!assertSameOrigin(req)) return jsonError("forbidden", 403);

  // Fail-CLOSED on a missing/invalid Content-Length (matches the admin upload
  // routes): a real generation request always carries a body, so an absent length
  // is either not a browser or an attempt to stream an unbounded body past the
  // per-field caps (which only apply AFTER buffering). Reject before req.json().
  const lenHeader = req.headers.get("content-length");
  const len = lenHeader === null ? NaN : Number(lenHeader);
  if (!Number.isFinite(len) || len <= 0 || len > MAX_BODY) {
    return jsonError("payload_too_large", 413);
  }

  // Protects OUR proxy bandwidth (it's the user's own key/cost otherwise). Keyed
  // to a fixed studio bucket since presenters share one credential.
  const rl = await checkRateLimit("studio");
  if (!rl.allowed) return jsonError("rate_limited", 429, { retryAfter: rl.retryAfter });

  // The BYO key — read here, used ONLY in the upstream Authorization header below.
  const key = (req.headers.get("x-openrouter-key") || "").trim();
  if (!key) return jsonError("missing_key", 400);
  if (key.length > MAX_KEY) return jsonError("bad_key", 400);

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return jsonError("bad_request", 400);
  }
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return jsonError("empty_prompt", 400);
  if (prompt.length > MAX_PROMPT) return jsonError("prompt_too_long", 400);
  const currentHtml = typeof body.currentHtml === "string" ? body.currentHtml : "";
  if (currentHtml.length > MAX_HTML) return jsonError("payload_too_large", 413);

  // Model chosen SERVER-SIDE (never a raw user string). Reasoning is left OFF so
  // the stream carries only delta.content (the client concatenates that alone).
  const model =
    process.env.STUDIO_MODEL || process.env.OPENROUTER_MODEL || "deepseek/deepseek-v4-flash";

  const userContent = currentHtml
    ? `Here is the current deck HTML. Apply my request and return the COMPLETE updated HTML document (all slides), following all the rules.\n\nMY REQUEST:\n${prompt}\n\nCURRENT DECK HTML:\n${currentHtml}`
    : prompt;

  const payload = {
    model,
    stream: true,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
  };

  let upstream: Response;
  try {
    upstream = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`, // the ONLY place the key is ever used
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.OPENROUTER_SITE_URL ?? "",
        "X-Title": process.env.OPENROUTER_SITE_NAME ?? "VibeDeck Studio",
      },
      body: JSON.stringify(payload),
      // Client disconnect (tab closed) aborts the upstream call so the presenter's
      // own tokens stop burning. A full-deck stream is legitimately long, so there
      // is deliberately NO short fixed timeout here (unlike /api/ask's 45s cap).
      signal: req.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return new Response(null, { status: 499 }); // client went away
    }
    return jsonError("request_failed", 502);
  }

  if (!upstream.ok || !upstream.body) {
    // STATUS ONLY — never the upstream body.
    console.error(`[studio] OpenRouter responded ${upstream.status}`);
    if (upstream.status === 401 || upstream.status === 403) {
      return jsonError("invalid_key", 400); // the user's OpenRouter key was rejected
    }
    return jsonError("upstream_error", 502, { status: upstream.status });
  }

  // Stream the SSE body straight through. Explicit headers only — we NEVER copy
  // upstream.headers (that would forward set-cookie / rate-limit headers). The
  // client parses the SSE deltas and concatenates choices[].delta.content.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no", // don't let a proxy buffer the stream
    },
  });
}
