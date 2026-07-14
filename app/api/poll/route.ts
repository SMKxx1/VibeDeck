import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, verifySessionToken, getSession as getAuthSession, type Session } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/csrf";
import { openPoll, revealPoll, closePoll, getLiveTally, getActivePoll, setBranchTaken } from "@/lib/poll";
import { generatePollExplanation } from "@/lib/poll-explain";
import { getSlideBranches } from "@/lib/slides-store";
import { setPresenterIndex, getSession } from "@/lib/session";
import { bumpPulse } from "@/lib/pulse";

// Live poll control — PRESENTER ONLY.
//   POST { action: "open" | "reveal" | "close" | "route", ... } drives the poll
//        lifecycle. "open" with kind:"branch" + index opens a BRANCH VOTE on the
//        current slide's authored paths (server-read from deck_slides — the body
//        never carries targets); "route" jumps the whole room to a revealed
//        branch vote's chosen path (driver-gated, like any shared-index write).
//   GET  ?slug= returns the current poll + its LIVE tally (only the presenter polls
//        this; viewers receive the poll via /api/session and see the tally only
//        after reveal). Any valid presenter cookie may run a poll for the deck
//        they're presenting — this is a live-session action, not deck management.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

async function isPresenter(): Promise<boolean> {
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  return verifySessionToken(token);
}

// Co-host mode: the clicker identity for the "route" jump — same sentinel rule as
// app/api/session/route.ts driverIdFor (a legacy v<2 cookie is the pre-accounts
// admin, one stable identity).
function driverIdFor(session: Session): string {
  return session.userId ?? "legacy-admin";
}

interface PostBody {
  slug?: string;
  action?: string;
  question?: string;
  options?: unknown;
  correctIndex?: number;
  /** "open" only: "branch" opens a branch vote for the slide at `index`. */
  kind?: string;
  /** "open" kind:"branch": the branch-point slide (0-based). */
  index?: number;
  /** "route": the branch option to route the room to. */
  optionIndex?: number;
}

export async function POST(req: Request) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  // Identity, not just validity: the "route" action moves the shared slide index,
  // which is clicker-gated per presenter userId (Co-host mode). getAuthSession
  // runs the IDENTICAL signature/expiry/role checks as verifySessionToken — same
  // gate as before, plus who is asking.
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  const auth = getAuthSession(token);
  if (!auth) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const slug = (body.slug ?? "").toString();
  if (!slug) return NextResponse.json({ error: "missing_slug" }, { status: 400 });
  const action = (body.action ?? "").toString();

  // Branch vote (branch points): options ARE the slide's authored branch labels,
  // read server-side from deck_slides — never from the request body — so a vote
  // can only ever offer the paths the deck actually declares.
  if (action === "open" && body.kind === "branch") {
    const index = body.index;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
      return NextResponse.json({ error: "bad_index" }, { status: 400 });
    }
    const branches = await getSlideBranches(slug, index);
    if (!branches) return NextResponse.json({ error: "no_branches" }, { status: 400 });
    const question =
      (body.question ?? "").toString().trim().slice(0, 400) || "Where should we go next?";
    const poll = await openPoll(slug, {
      question,
      options: branches.map((b) => b.label),
      correctIndex: null,
      kind: "branch",
      branches,
    });
    return NextResponse.json(
      { poll, tally: new Array(poll.options.length).fill(0), total: 0 },
      { headers: NO_STORE },
    );
  }

  if (action === "open") {
    const question = (body.question ?? "").toString().trim();
    const options = Array.isArray(body.options)
      ? body.options.map((o) => (o ?? "").toString())
      : [];
    const cleaned = options.map((o) => o.trim()).filter((o) => o.length > 0);
    if (!question) return NextResponse.json({ error: "missing_question" }, { status: 400 });
    if (cleaned.length < 2) return NextResponse.json({ error: "need_options" }, { status: 400 });
    const correctIndex =
      typeof body.correctIndex === "number" ? body.correctIndex : null;
    const poll = await openPoll(slug, { question, options, correctIndex });
    return NextResponse.json({ poll, tally: new Array(poll.options.length).fill(0), total: 0 }, { headers: NO_STORE });
  }

  if (action === "reveal") {
    // Read the pre-reveal state first so a repeated "reveal" (idempotent for the
    // poll itself) can't double-count the wrong votes below.
    const prior = await getActivePoll(slug);
    const poll = await revealPoll(slug);
    if (!poll) return NextResponse.json({ error: "no_poll" }, { status: 404 });
    // Insight Engine: a knowledge-check with a correct answer just froze its
    // tally — count the WRONG votes as struggle signals on the heat strip.
    // Polls aren't per-slide, so attribute them to the room's CURRENT live slide
    // (same convention as an "I'm lost" signal). Content-free (a count only —
    // never who voted) and fire-and-forget: it must never affect the reveal.
    if (prior && !prior.revealed && poll.correctIndex !== null && poll.tally) {
      const wrong = Math.max(0, (poll.total ?? 0) - (poll.tally[poll.correctIndex] ?? 0));
      if (wrong > 0) {
        void getSession(slug)
          .then((s) => bumpPulse(slug, s.index, "poll_wrong", wrong))
          .catch(() => {});
      }
    }
    // "Why that answer": kick off the ONE room-wide grounded explanation without
    // awaiting it — a reveal must never wait on (or fail with) an AI call. It
    // writes back onto the frozen poll and reaches everyone on a later session
    // tick. No-ops internally for opinion polls and already-explained reveals.
    void generatePollExplanation(slug, poll);
    return NextResponse.json({ poll, tally: poll.tally ?? [], total: poll.total ?? 0 }, { headers: NO_STORE });
  }

  // Route the room to a chosen branch: a driver-gated session JUMP to the path's
  // first slide (setPresenterIndex both moves the index and unlocks up to it).
  // Untaken branches stay reachable — routing again (or plain navigation) is fine.
  if (action === "route") {
    const poll = await getActivePoll(slug);
    if (!poll || poll.kind !== "branch") {
      return NextResponse.json({ error: "no_branch_poll" }, { status: 404 });
    }
    if (!poll.revealed) return NextResponse.json({ error: "not_revealed" }, { status: 409 });
    const optionIndex = body.optionIndex;
    const target =
      typeof optionIndex === "number" && Number.isInteger(optionIndex)
        ? poll.branches?.[optionIndex]
        : undefined;
    if (!target) return NextResponse.json({ error: "bad_option" }, { status: 400 });

    // Clicker rule: with a mismatching driver on record this is a NO-OP that
    // returns the current state — a moderator can reveal the vote but only the
    // driver moves the room. `routed` tells the caller which one happened.
    const state = await setPresenterIndex(slug, target.from, driverIdFor(auth));
    const routed = state.index === target.from;
    const updated = routed ? await setBranchTaken(slug, poll.id, optionIndex as number) : null;
    return NextResponse.json(
      { poll: updated ?? poll, index: state.index, max: state.max, routed },
      { headers: NO_STORE },
    );
  }

  if (action === "close") {
    await closePoll(slug);
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  }

  return NextResponse.json({ error: "bad_action" }, { status: 400 });
}

export async function GET(req: Request) {
  if (!(await isPresenter())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const slug = new URL(req.url).searchParams.get("slug") ?? "";
  if (!slug) return NextResponse.json({ error: "missing_slug" }, { status: 400 });
  const live = await getLiveTally(slug);
  if (!live) return NextResponse.json({ poll: null }, { headers: NO_STORE });
  return NextResponse.json(
    { poll: live.poll, tally: live.tally, total: live.total },
    { headers: NO_STORE },
  );
}
