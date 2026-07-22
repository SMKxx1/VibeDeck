import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, verifySessionToken, getSession as getAuthSession, type Session } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/csrf";
import {
  MAX_OPTION_LEN,
  MAX_OPTIONS,
  MAX_QUESTION,
  openPoll,
  revealPollWithStatus,
  closePoll,
  getLiveTally,
  getActivePoll,
  routeBranch,
} from "@/lib/poll";
import { generatePollExplanation } from "@/lib/poll-explain";
import { getSlideBranches } from "@/lib/slides-store";
import { getSession } from "@/lib/session";
import { bumpPulse } from "@/lib/pulse";
import { getDeck } from "@/lib/decks";
import { isValidDeckSlug } from "@/lib/request-security";

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
  if (!isValidDeckSlug(slug)) {
    return NextResponse.json({ error: "bad_slug" }, { status: 400 });
  }
  const action = (body.action ?? "").toString();

  // Branch vote (branch points): options ARE the slide's authored branch labels,
  // read server-side from deck_slides — never from the request body — so a vote
  // can only ever offer the paths the deck actually declares.
  if (action === "open" && body.kind === "branch") {
    const index = body.index;
    if (
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 0 ||
      index > 10_000
    ) {
      return NextResponse.json({ error: "bad_index" }, { status: 400 });
    }
    const branches = await getSlideBranches(slug, index);
    if (!branches) return NextResponse.json({ error: "no_branches" }, { status: 400 });
    const question =
      (body.question ?? "").toString().trim().slice(0, 400) || "Where should we go next?";
    let poll;
    try {
      poll = await openPoll(slug, {
        question,
        options: branches.map((b) => b.label),
        correctIndex: null,
        kind: "branch",
        branches,
      });
    } catch {
      return NextResponse.json({ error: "live_state_unavailable" }, { status: 503 });
    }
    return NextResponse.json(
      { poll, tally: new Array(poll.options.length).fill(0), total: 0 },
      { headers: NO_STORE },
    );
  }

  if (action === "open") {
    const question = (body.question ?? "").toString().trim();
    const options = Array.isArray(body.options)
      ? body.options.slice(0, MAX_OPTIONS).map((o) => (o ?? "").toString().slice(0, MAX_OPTION_LEN))
      : [];
    const cleaned = options.map((o) => o.trim()).filter((o) => o.length > 0);
    if (!question || question.length > MAX_QUESTION) {
      return NextResponse.json({ error: "bad_question" }, { status: 400 });
    }
    if (cleaned.length < 2) return NextResponse.json({ error: "need_options" }, { status: 400 });
    const correctIndex =
      typeof body.correctIndex === "number" ? body.correctIndex : null;
    let poll;
    try {
      poll = await openPoll(slug, { question, options, correctIndex });
    } catch {
      return NextResponse.json({ error: "live_state_unavailable" }, { status: 503 });
    }
    return NextResponse.json({ poll, tally: new Array(poll.options.length).fill(0), total: 0 }, { headers: NO_STORE });
  }

  if (action === "reveal") {
    let result;
    try {
      result = await revealPollWithStatus(slug);
    } catch {
      return NextResponse.json({ error: "live_state_unavailable" }, { status: 503 });
    }
    if (!result) return NextResponse.json({ error: "no_poll" }, { status: 404 });
    const { poll, revealedNow } = result;
    // Insight Engine: a knowledge-check with a correct answer just froze its
    // tally — count the WRONG votes as struggle signals on the heat strip.
    // Polls aren't per-slide, so attribute them to the room's CURRENT live slide
    // (same convention as an "I'm lost" signal). Content-free (a count only —
    // never who voted) and fire-and-forget: it must never affect the reveal.
    if (revealedNow && poll.correctIndex !== null && poll.tally) {
      const wrong = Math.max(0, (poll.total ?? 0) - (poll.tally[poll.correctIndex] ?? 0));
      if (wrong > 0) {
        void (async () => {
          const s = await getSession(slug);
          await bumpPulse(slug, s.index, "poll_wrong", wrong);
        })().catch(() => {});
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

    // Clamp the (possibly stale/oversized) branch target to the deck's real range
    // so a bad `from` can't jump the whole room past the last slide and jam the
    // unlock ceiling. slideCount from getDeck (slideCount for embed/uploaded, else
    // slides.length), matching how the other routes read a deck's length.
    const deck = await getDeck(slug);
    const slideCount = deck ? deck.slideCount ?? deck.slides.length : 0;
    const from =
      slideCount > 0 ? Math.min(Math.max(0, target.from), slideCount - 1) : Math.max(0, target.from);

    // Clicker rule: with a mismatching driver on record this is a NO-OP that
    // returns the current state — a moderator can reveal the vote but only the
    // driver moves the room. `routed` tells the caller which one happened.
    const me = driverIdFor(auth);
    try {
      const result = await routeBranch(slug, poll.id, optionIndex as number, from, me);
      if (!result) {
        return NextResponse.json({ error: "stale_poll" }, { status: 409 });
      }
      return NextResponse.json(
        {
          poll: result.poll,
          index: result.state.index,
          max: result.state.max,
          routed: result.routed,
        },
        { headers: NO_STORE },
      );
    } catch {
      return NextResponse.json({ error: "live_state_unavailable" }, { status: 503 });
    }
  }

  if (action === "close") {
    try {
      await closePoll(slug);
    } catch {
      return NextResponse.json({ error: "live_state_unavailable" }, { status: 503 });
    }
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  }

  return NextResponse.json({ error: "bad_action" }, { status: 400 });
}

export async function GET(req: Request) {
  if (!(await isPresenter())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const slug = new URL(req.url).searchParams.get("slug") ?? "";
  if (!isValidDeckSlug(slug)) {
    return NextResponse.json({ error: "bad_slug" }, { status: 400 });
  }
  const live = await getLiveTally(slug);
  if (!live) return NextResponse.json({ poll: null }, { headers: NO_STORE });
  return NextResponse.json(
    { poll: live.poll, tally: live.tally, total: live.total },
    { headers: NO_STORE },
  );
}
