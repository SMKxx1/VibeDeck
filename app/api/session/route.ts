import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  driverIdFor,
  getSession,
  setPresenterIndex,
  resetLock,
  heartbeat,
  takeClicker,
  isLive,
} from "@/lib/session";
import { AUTH_COOKIE, verifySessionToken, getSession as getAuthSession } from "@/lib/auth";
import { NO_STORE } from "@/lib/api-helpers";
import { assertSameOrigin } from "@/lib/csrf";
import { isDeckViewable } from "@/lib/publish-store";
import { getActivePoll, pollForViewer } from "@/lib/poll";
import { getRecap } from "@/lib/recap";
import { getActivity } from "@/lib/activity";
import { isValidDeckSlug } from "@/lib/request-security";

// The live-session channel. Viewers GET the presenter's position (polled);
// the presenter POSTs its position (and can "reset the lock"). Only a valid
// presenter cookie may write.
//
// Co-host mode: any valid presenter may run the live room (polls, recaps, Q&A,
// reset lock, heartbeat), but only the presenter holding "the clicker" moves the
// shared slide index. `{takeClicker:true}` claims it; a non-driver's position
// POST is a no-op for the shared index (they still get state back). Both verbs
// return `isDriver` for the CALLER so the console knows whether it drives.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const slug = new URL(req.url).searchParams.get("slug") ?? "";
  if (!isValidDeckSlug(slug)) {
    return NextResponse.json({ error: "bad_slug" }, { status: 400 });
  }

  // Publish gate: don't leak the live position of an unpublished deck to a
  // non-presenter. 404 (no "unknown_deck" convention pre-exists on this route, so
  // a clean not_found shape is fine) keeps it indistinguishable from an unknown
  // deck. Presenters (valid cookie) always pass.
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  const isPresenter = verifySessionToken(token);
  if (!(await isDeckViewable(slug, isPresenter))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Batch the four independent reads into ONE round-trip — each is keyed only by
  // slug and none depends on another's result, so awaiting them separately just
  // paid four sequential RTTs per viewer tick. Promise.all lets ioredis pipeline
  // them over the single connection.
  const [state, activePoll, recap, activity] = await Promise.all([
    getSession(slug),
    // The current live poll on the SAME poll viewers already run (#3) — no new
    // viewer request. Viewer-safe projection below: no correct answer/tally pre-reveal.
    getActivePoll(slug),
    // The active room recap (comprehension checkpoint). Viewer-safe as-is: it's
    // presenter-authored/approved text about a slide they can already see.
    getRecap(slug),
    // The Turn & Talk activity. Viewer-safe as-is: a presenter-authored prompt + a
    // wall-clock deadline; viewers count down client-side from `endsAt`, so this
    // poll's cadence never changes.
    getActivity(slug),
  ]);
  const poll = pollForViewer(activePoll);
  // Co-host mode: driverId is a userId — never leak it to the room. A presenter
  // caller instead gets `isDriver` for THEIR identity (an unclaimed session counts
  // as driving, so a solo console never shows a handoff button).
  const { driverId, ...pub } = state;
  const auth = isPresenter ? getAuthSession(token) : null;
  const extra = auth ? { isDriver: !driverId || driverId === driverIdFor(auth) } : {};
  return NextResponse.json(
    { ...pub, live: isLive(state), poll, recap, activity, ...extra },
    { headers: NO_STORE },
  );
}

interface PostBody {
  slug?: string;
  index?: number;
  reset?: boolean;
  heartbeat?: boolean;
  takeClicker?: boolean;
}

export async function POST(req: Request) {
  // CSRF: reject a browser-attested cross-origin write first (see lib/csrf.ts —
  // Lax cookie + same-site deck subdomain gap). Same 403 forbidden shape as the
  // bad-token case just below, so the two rejections read identically.
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  // Identity, not just validity: the clicker is held per presenter userId.
  // getAuthSession runs the IDENTICAL signature/expiry/role checks as
  // verifySessionToken, so this is the same gate — plus who is asking.
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

  if (
    !body.takeClicker &&
    !body.reset &&
    !body.heartbeat &&
    (typeof body.index !== "number" ||
      !Number.isInteger(body.index) ||
      body.index < 0 ||
      body.index > 10_000)
  ) {
    return NextResponse.json({ error: "bad_index" }, { status: 400 });
  }

  const me = driverIdFor(auth);
  let state;
  try {
    state = body.takeClicker
      ? await takeClicker(slug, me)
      : body.reset
        ? await resetLock(slug)
        : body.heartbeat
          ? await heartbeat(slug)
          : await setPresenterIndex(slug, body.index as number, me);
  } catch {
    return NextResponse.json({ error: "live_state_unavailable" }, { status: 503 });
  }
  // Same shape discipline as GET: no raw driverId out, `isDriver` for the caller.
  const { driverId, ...pub } = state;
  return NextResponse.json(
    { ...pub, live: isLive(state), isDriver: !driverId || driverId === me },
    { headers: NO_STORE },
  );
}
