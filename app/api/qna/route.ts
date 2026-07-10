import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/csrf";
import { isDeckViewable } from "@/lib/publish-store";
import { checkRateLimit } from "@/lib/kv";
import { addQuestion, upvote, setAnswered, setDismissed, getQuestions } from "@/lib/qna";

// Upvotable Q&A queue (#5).
//   GET  ?slug=            — the queue (publish-gated; the presenter also sees
//                            dismissed items). Viewers read it to upvote.
//   POST action:"ask"      — a VIEWER posts a question (publish-gated, rate-limited)
//   POST action:"upvote"   — a VIEWER upvotes {qid} (publish-gated, rate-limited)
//   POST action:"answer"|"dismiss"|"undismiss" {qid} — PRESENTER-ONLY curation

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

function cleanName(raw: unknown): string {
  return (
    (raw ?? "")
      .toString()
      .replace(/[^\p{L}\p{N} .,'-]/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 40) || "anonymous"
  );
}

async function isPresenterReq(): Promise<boolean> {
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  return verifySessionToken(token);
}

export async function GET(req: Request) {
  const slug = new URL(req.url).searchParams.get("slug") ?? "";
  if (!slug) return NextResponse.json({ error: "missing_slug" }, { status: 400 });
  const isPresenter = await isPresenterReq();
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
  if (!slug) return NextResponse.json({ error: "missing_slug" }, { status: 400 });

  // --- Presenter curation (answer / dismiss / undismiss) ---
  if (action === "answer" || action === "dismiss" || action === "undismiss") {
    if (!(await isPresenterReq())) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    const qid = (body.qid ?? "").toString();
    if (!qid) return NextResponse.json({ error: "missing_qid" }, { status: 400 });
    const ok =
      action === "answer"
        ? await setAnswered(slug, qid, true)
        : await setDismissed(slug, qid, action === "dismiss");
    if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const questions = await getQuestions(slug, true);
    return NextResponse.json({ ok: true, questions }, { headers: NO_STORE });
  }

  // --- Viewer actions (ask / upvote): publish-gated + rate-limited ---
  const isPresenter = await isPresenterReq();
  if (!(await isDeckViewable(slug, isPresenter))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const name = cleanName(body.name);

  if (action === "ask") {
    const rl = await checkRateLimit(`qna:${name}`);
    if (!rl.allowed) {
      return NextResponse.json({ error: "rate_limited", retryAfter: rl.retryAfter }, { status: 429 });
    }
    const q = await addQuestion(slug, name, (body.text ?? "").toString());
    if (!q) return NextResponse.json({ error: "rejected" }, { status: 400 }); // empty or queue full
    return NextResponse.json({ ok: true, question: q }, { headers: NO_STORE });
  }

  if (action === "upvote") {
    const qid = (body.qid ?? "").toString();
    if (!qid) return NextResponse.json({ error: "missing_qid" }, { status: 400 });
    const rl = await checkRateLimit(`qnavote:${name}`);
    if (!rl.allowed) {
      return NextResponse.json({ error: "rate_limited", retryAfter: rl.retryAfter }, { status: 429 });
    }
    const votes = await upvote(slug, qid, name);
    if (votes === null) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true, votes }, { headers: NO_STORE });
  }

  return NextResponse.json({ error: "bad_action" }, { status: 400 });
}
