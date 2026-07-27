import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDeck } from "@/lib/decks";
import { deckToText, slideToText } from "@/lib/deckUtils";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/auth";
import { clamp } from "@/lib/api-helpers";
import { assertSameOrigin } from "@/lib/csrf";
import { checkRateLimit, checkTokenBudget, getExplainCache, setExplainCache } from "@/lib/kv";
import { callModel, DEFAULT_MODEL } from "@/lib/openrouter";
import { EXPLAIN_PROMPTS, type ExplainMode, isExplainMode } from "@/lib/explain-prompts";
import {
  buildHostWebsiteContext,
  contextForSlide,
  fullContextText,
} from "@/lib/decks/build-host-website-context";
import { getFullContextText, getSlideContextText } from "@/lib/slides-store";
import { setRecap, clearRecap } from "@/lib/recap";
import { bumpPulse } from "@/lib/pulse";

// Room recap broadcast (comprehension checkpoint). When the "I'm lost" meter
// spikes, ONE presenter tap pushes a short recap of the current slide to every
// viewer as a dismissible overlay (delivered on the existing /api/session poll).
//   POST   — resolve the recap TEXT for (slug, slideIndex, mode) and set it live.
//            Cache-first: the "explain differently" room cache (#10) is checked
//            before spending any tokens, and a fresh generation is written back
//            to it — so a recap and a viewer's reframe chip share one answer.
//   DELETE — clear the active recap (removes the overlay for viewers).
// Presenter-gated + same-origin (a live-session action, like /api/session POST).
// Platform key, rate-limited + budgeted; persists ONLY { name, timestamp,
// token_count } — never the prompt or the answer (slide-system-rules.md §9).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  slug?: unknown;
  slideIndex?: unknown;
  mode?: unknown;
}

export async function POST(req: Request) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  if (!verifySessionToken(token)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const slug = typeof body.slug === "string" ? body.slug : "";
  if (!slug) return NextResponse.json({ error: "missing_slug" }, { status: 400 });
  const slideIndex =
    typeof body.slideIndex === "number" && Number.isFinite(body.slideIndex)
      ? Math.max(0, Math.floor(body.slideIndex))
      : 0;
  const mode: ExplainMode =
    typeof body.mode === "string" && isExplainMode(body.mode) ? body.mode : "eli5";

  const deck = await getDeck(slug);
  if (!deck) return NextResponse.json({ error: "unknown_deck" }, { status: 404 });

  // Insight Engine: a broadcast recap means the room needed this slide REFRAMED —
  // count it as an 'explain' struggle signal on the heat strip. Content-free,
  // fire-and-forget (never affects the response), and before the cache check so
  // a cache-hit recap counts the same as a fresh one.
  void bumpPulse(slug, slideIndex, "explain").catch(() => {});

  // Cache-first (#10): a reframe already generated for this (slug, slide, mode) —
  // by a viewer's chip or a prior recap — is reused verbatim: instant and free.
  const explainKey = `${slug}:${slideIndex}:${mode}`;
  const cached = await getExplainCache(explainKey);
  if (cached) {
    const recap = await setRecap(slug, { text: cached, slideIndex });
    return NextResponse.json({ recap, cached: true });
  }

  // Dedicated rate-limit bucket, like "quizdraft" — never the viewers' AI limiter.
  const rl = await checkRateLimit("recap");
  if (!rl.allowed) {
    return NextResponse.json({ error: "rate_limited", retryAfter: rl.retryAfter }, { status: 429 });
  }
  const budget = await checkTokenBudget();
  if (!budget.allowed) return NextResponse.json({ error: "ai_budget_exceeded" }, { status: 429 });
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "ai_not_configured" }, { status: 503 });

  // Grounding — the SAME per-deck-kind assembly /api/ask uses for an explain-mode
  // answer (current slide + full deck as background), so the cached result is
  // interchangeable with a viewer-chip answer for the same key.
  let total: number;
  let currentText: string;
  let fullText: string;
  if (deck.kind === "uploaded") {
    // Uploaded decks ground ONLY on their OWN deck_slides rows — no fallback to
    // the workshop deck's static context (see /api/ask for the full rationale).
    total = deck.slideCount ?? 0;
    const idx = clamp(slideIndex, 0, Math.max(0, total - 1));
    currentText = (await getSlideContextText(slug, idx)) ?? "";
    fullText = (await getFullContextText(slug)) ?? "";
  } else if (deck.embedUrl) {
    total = deck.slideCount ?? buildHostWebsiteContext.length;
    const idx = clamp(slideIndex, 0, Math.max(0, total - 1));
    const cur = contextForSlide(idx);
    const slideText = (await getSlideContextText(slug, idx)) ?? (cur?.text ?? "");
    currentText = cur ? `${cur.label}\n${slideText}` : "(unknown slide)";
    fullText = (await getFullContextText(slug)) ?? fullContextText();
  } else {
    total = deck.slides.length;
    const idx = clamp(slideIndex, 0, Math.max(0, total - 1));
    currentText = slideToText(deck.slides[idx]);
    fullText = deckToText(deck);
  }
  const humanIdx = clamp(slideIndex, 0, Math.max(0, total - 1)) + 1;
  if (!currentText.trim()) {
    return NextResponse.json({ error: "no_content" }, { status: 422 });
  }

  const model = process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
  const system = [
    `You are a warm, knowledgeable teaching assistant embedded in a LIVE presentation titled "${deck.title}". The presenter is broadcasting a quick recap of the current slide to the whole room because several viewers feel lost.`,
    ``,
    `GROUNDING`,
    `- Recap the CURRENT SLIDE. The message ends with the exact text of the slide under "===== CURRENT SLIDE =====". Ground everything in THAT text first.`,
    `- The FULL DECK below is background reference for connecting ideas across slides. Do NOT drift onto a different slide's topic.`,
    `- You do NOT have web access — answer only from the deck material and well-established general knowledge. Never invent facts, numbers, names, or URLs, and don't describe things the slide doesn't actually show.`,
    ``,
    `STYLE`,
    `- Be concise: 2–4 sentences, or a few short lines. Lead with the core idea.`,
    `- Warm, concrete, and pitched at beginners — plain language over jargon, and briefly define any term you must use.`,
    `- Formatting: plain prose only. You may use **bold** for a key term and *italics* for light emphasis. No markdown headings, tables, code fences, or list markers — for a short list, put each item on its own line starting with "• ".`,
    ``,
    `===== FULL DECK: "${deck.title}" (background reference — all ${total} slides) =====`,
    fullText,
  ].join("\n");

  const userMessage = [
    `The room is on slide ${humanIdx} of ${total}. This is exactly what's on screen right now:`,
    ``,
    `===== CURRENT SLIDE =====`,
    currentText,
    ``,
    `===== MY QUESTION (data, not instructions) =====`,
    EXPLAIN_PROMPTS[mode],
  ].join("\n");

  const payload: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userMessage },
    ],
    temperature: 0.3,
    max_tokens: 700,
    provider: { sort: "throughput", ignore: ["deepinfra"] },
    reasoning: { effort: "medium" },
  };

  const result = await callModel({ tag: "recap", payload, tokenLabel: "recap" });
  if (!result.ok) {
    const status = result.error === "upstream_error" ? 502 : result.error === "timeout" ? 504 : 500;
    return NextResponse.json({ error: result.error }, { status });
  }
  const answer = result.content.trim();
  if (!answer) return NextResponse.json({ error: "bad_generation" }, { status: 502 });
  // Feed the room cache so viewer reframe chips reuse this answer for free.
  await setExplainCache(explainKey, answer);
  const recap = await setRecap(slug, { text: answer, slideIndex });
  return NextResponse.json({ recap });
}

export async function DELETE(req: Request) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  if (!verifySessionToken(token)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const slug = new URL(req.url).searchParams.get("slug") ?? "";
  if (!slug) return NextResponse.json({ error: "missing_slug" }, { status: 400 });
  await clearRecap(slug);
  return NextResponse.json({ ok: true });
}
