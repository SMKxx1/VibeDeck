import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/auth";
import { isDbReachable } from "@/lib/db";
import { getDeckSlides, updateSlideMeta } from "@/lib/slides-store";

// Presenter-gated editor API for per-slide speaker notes + AI grounding context.
// GET reads a deck's slide metadata; PUT saves one slide's edits. Both require a
// valid presenter cookie. Reads/writes go through lib/slides-store, which falls
// back gracefully — here we surface a 503 when there's genuinely no DB so the
// editor can show a clear message.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FIELD = 8000;

async function isPresenter(): Promise<boolean> {
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  return verifySessionToken(token);
}

export async function GET(req: Request) {
  if (!(await isPresenter())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const slug = new URL(req.url).searchParams.get("slug") ?? "";
  if (!slug) return NextResponse.json({ error: "missing_slug" }, { status: 400 });

  // Distinguish "DB down" from "deck simply has no slides" by actually probing
  // reachability — a set-but-unreachable DATABASE_URL must surface, not degrade.
  if (!(await isDbReachable())) {
    return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
  }
  const slides = await getDeckSlides(slug);
  return NextResponse.json({ slug, slides });
}

interface PutBody {
  slug?: string;
  index?: number;
  speakerNotes?: string;
  aiContext?: string;
}

export async function PUT(req: Request) {
  if (!(await isPresenter())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: PutBody;
  try {
    body = (await req.json()) as PutBody;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const slug = (body.slug ?? "").toString();
  if (!slug) return NextResponse.json({ error: "missing_slug" }, { status: 400 });

  const index = body.index;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
    return NextResponse.json({ error: "bad_index" }, { status: 400 });
  }

  const patch: { speakerNotes?: string; aiContext?: string } = {};
  if (body.speakerNotes !== undefined) {
    const v = String(body.speakerNotes);
    if (v.length > MAX_FIELD) return NextResponse.json({ error: "too_long" }, { status: 400 });
    patch.speakerNotes = v;
  }
  if (body.aiContext !== undefined) {
    const v = String(body.aiContext);
    if (v.length > MAX_FIELD) return NextResponse.json({ error: "too_long" }, { status: 400 });
    patch.aiContext = v;
  }

  const result = await updateSlideMeta(slug, index, patch);
  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? "database_unavailable" }, { status: 503 });
  }
  return NextResponse.json({ ok: true });
}
