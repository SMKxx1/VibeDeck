import { NextResponse } from "next/server";
import { isPresenterRequest } from "@/lib/auth";
import { NO_STORE, cleanName } from "@/lib/api-helpers";
import { assertSameOrigin } from "@/lib/csrf";
import { isDeckViewable } from "@/lib/publish-store";
import { checkRateLimit } from "@/lib/kv";
import { addQuestion, upvote, setAnswered, setDismissed, getQuestions, MAX_TEXT } from "@/lib/qna";
import { checkPublicRateLimit, isValidDeckSlug } from "@/lib/request-security";

// Upvotable Q&A queue (#5).
//   GET  ?slug=            — the queue (publish-gated; the presenter also sees
//                            dismissed items). Viewers read it to upvote.
//   POST action:"ask"      — a VIEWER posts a question (publish-gated, rate-limited)
//   POST action:"upvote"   — a VIEWER upvotes {qid} (publish-gated, rate-limited)
//   POST action:"answer"|"dismiss"|"undismiss" {qid} — PRESENTER-ONLY curation

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LIVE_ID_RE = /^[A-Za-z0-9_-]{12}$/;

export async function GET(req: Request) {
  const slug = new URL(req.url).searchParams.get("slug") ?? "";
  if (!isValidDeckSlug(slug)) {
    return NextResponse.json({ error: "bad_slug" }, { status: 400 });
  }
  const isPresenter = await isPresenterRequest();
  if (!(await isDeckViewable(slug, isPresenter))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const questions = await getQuestions(slug, isPresenter);
  return NextResponse.json({ questions }, { headers: NO_STORE });
}

interface PostBody {
  slug?: string;
  action?: string;
  name?: string;
  text?: string;
  qid?: string;
}

export async function POST(req: Request) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const slug = (body.slug ?? "").toString();
  const action = (body.action ?? "").toString();
  if (!isValidDeckSlug(slug)) {
    return NextResponse.json({ error: "bad_slug" }, { status: 400 });
  }

  // --- Presenter curation (answer / dismiss / undismiss) ---
  if (action === "answer" || action === "dismiss" || action === "undismiss") {
    if (!(await isPresenterRequest())) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    const qid = (body.qid ?? "").toString();
    if (!LIVE_ID_RE.test(qid)) {
      return NextResponse.json({ error: "bad_qid" }, { status: 400 });
    }
    let ok: boolean;
    try {
      ok =
        action === "answer"
          ? await setAnswered(slug, qid, true)
          : await setDismissed(slug, qid, action === "dismiss");
    } catch {
      return NextResponse.json({ error: "live_state_unavailable" }, { status: 503 });
    }
    if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const questions = await getQuestions(slug, true);
    return NextResponse.json({ ok: true, questions }, { headers: NO_STORE });
  }

  // --- Viewer actions (ask / upvote): publish-gated + rate-limited ---
  const isPresenter = await isPresenterRequest();
  if (!(await isDeckViewable(slug, isPresenter))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const name = cleanName(body.name);

  if (action === "ask") {
    const text = (body.text ?? "").toString();
    if (!text.trim() || text.length > MAX_TEXT) {
      return NextResponse.json({ error: "bad_question" }, { status: 400 });
    }
    const [publicLimit, identityLimit] = await Promise.all([
      checkPublicRateLimit(req, "qna-ask", `${slug}:${name}`, {
        max: 1_000,
        windowSeconds: 60,
      }),
      checkRateLimit(`qna:${slug}:${name}`, { max: 10, windowSeconds: 60 }),
    ]);
    if (!publicLimit.allowed || !identityLimit.allowed) {
      return NextResponse.json(
        {
          error: "rate_limited",
          retryAfter: Math.max(publicLimit.retryAfter, identityLimit.retryAfter),
        },
        { status: 429 },
      );
    }
    let q;
    try {
      q = await addQuestion(slug, name, text);
    } catch {
      return NextResponse.json({ error: "live_state_unavailable" }, { status: 503 });
    }
    if (!q) return NextResponse.json({ error: "queue_full" }, { status: 429 });
    return NextResponse.json({ ok: true, question: q }, { headers: NO_STORE });
  }

  if (action === "upvote") {
    const qid = (body.qid ?? "").toString();
    if (!LIVE_ID_RE.test(qid)) {
      return NextResponse.json({ error: "bad_qid" }, { status: 400 });
    }
    const [publicLimit, identityLimit] = await Promise.all([
      checkPublicRateLimit(req, "qna-upvote", `${slug}:${name}`, {
        max: 1_000,
        windowSeconds: 60,
      }),
      checkRateLimit(`qnavote:${slug}:${name}`, { max: 60, windowSeconds: 60 }),
    ]);
    if (!publicLimit.allowed || !identityLimit.allowed) {
      return NextResponse.json(
        {
          error: "rate_limited",
          retryAfter: Math.max(publicLimit.retryAfter, identityLimit.retryAfter),
        },
        { status: 429 },
      );
    }
    let votes;
    try {
      votes = await upvote(slug, qid, name);
    } catch {
      return NextResponse.json({ error: "live_state_unavailable" }, { status: 503 });
    }
    if (votes === null) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (votes === "full") return NextResponse.json({ error: "vote_full" }, { status: 429 });
    return NextResponse.json({ ok: true, votes }, { headers: NO_STORE });
  }

  return NextResponse.json({ error: "bad_action" }, { status: 400 });
}
