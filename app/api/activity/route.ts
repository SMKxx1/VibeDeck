import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/csrf";
import { setActivity, clearActivity, type ActivityFollowUp } from "@/lib/activity";

// Turn-and-Talk activity timer (lib/activity.ts). The presenter broadcasts a
// discussion/exercise prompt + a synchronized countdown to every viewer's screen
// (delivered on the existing /api/session poll — viewers count down client-side
// from `endsAt`).
//   POST   — start (or replace) the activity: { slug, prompt, durationSec,
//            followUp? } → the server computes `endsAt` at write time so the
//            whole room counts down to the same instant. `followUp` is a hint
//            ("poll" | "pinboard") rendered on the card and used by the
//            presenter's Regroup to chain into the next step.
//   DELETE — the "Regroup": clear the activity, ending it everywhere at once.
//            Chaining into a follow-up poll is handled CLIENT-side (the console
//            opens the reviewed ✨ poll-draft flow) — clearing is the must-have.
// Presenter-gated + same-origin (a live-session action, like /api/session POST /
// /api/recap).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  slug?: unknown;
  prompt?: unknown;
  durationSec?: unknown;
  followUp?: unknown;
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
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return NextResponse.json({ error: "missing_prompt" }, { status: 400 });
  const durationSec =
    typeof body.durationSec === "number" && Number.isFinite(body.durationSec)
      ? body.durationSec
      : 0;
  if (durationSec <= 0) {
    return NextResponse.json({ error: "bad_duration" }, { status: 400 });
  }
  const followUp: ActivityFollowUp | null =
    body.followUp === "poll" || body.followUp === "pinboard" ? body.followUp : null;

  const activity = await setActivity(slug, { prompt, durationSec, followUp });
  return NextResponse.json({ activity });
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
  await clearActivity(slug);
  return NextResponse.json({ ok: true });
}
