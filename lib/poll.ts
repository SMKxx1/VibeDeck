// Live polls / knowledge-checks (#3). The presenter opens one multiple-choice
// question at a time; viewers vote; the presenter reveals the tally (and the
// correct answer, if any). Reuses the live-session Redis patterns:
//   live:poll:<slug>              — the current poll (JSON), or absent = none
//   live:pollvotes:<slug>:<id>    — a HASH of name → chosen option index
// One field per voter = per-field atomic writes (a viewer changing their vote
// overwrites their own field only). The final tally is FROZEN into the poll record
// at reveal time so viewers can see it via the cheap session poll without every
// request recomputing it; only the presenter reads the LIVE pre-reveal tally.

import { randomBytes } from "crypto";
import { getRedis } from "./redis";
import type { SlideBranch } from "./types";

// A poll is either a regular question ("poll") or a BRANCH VOTE ("branch") — the
// audience choosing which path a branch-point slide takes (lib/types.ts
// SlideBranch). Branch votes reuse ALL of the vote/tally/reveal machinery below;
// the discriminator only tells clients to render them distinctly and carries the
// option→slide-range mapping needed to route the room afterwards.
export type PollKind = "poll" | "branch";

export interface Poll {
  id: string;
  /** Absent (pre-feature Redis records) = "poll". */
  kind?: PollKind;
  question: string;
  options: string[];
  correctIndex: number | null; // null = opinion poll (no right answer)
  revealed: boolean;
  tally: number[] | null; // frozen at reveal
  total: number | null; // frozen at reveal
  explanation?: string; // "why that answer" — attached AFTER reveal (see lib/poll-explain.ts)
  /** kind "branch" only: option i routes to branches[i] (parallel to options). */
  branches?: SlideBranch[];
  /** kind "branch" only: the option the room was routed to (set AFTER reveal). */
  takenIndex?: number;
  at: number;
}

// What a VIEWER is allowed to see: never the correct answer or tally until reveal.
export interface ViewerPoll {
  id: string;
  kind: PollKind;
  question: string;
  options: string[];
  revealed: boolean;
  correctIndex: number | null;
  tally: number[] | null;
  total: number | null;
  explanation: string | null;
  /** Branch vote breadcrumb: the routed option (post-reveal), else null. */
  takenIndex: number | null;
  at: number;
}

export const MAX_OPTIONS = 8;
export const MAX_QUESTION = 400;
export const MAX_OPTION_LEN = 200;
const MAX_EXPLANATION = 1200; // explanations are short model answers — a hard backstop

const pollKey = (slug: string) => `live:poll:${slug}`;
const votesKey = (slug: string, id: string) => `live:pollvotes:${slug}:${id}`;
const TTL_S = 60 * 60 * 8;

const g = globalThis as unknown as {
  __livePollMem?: Map<string, Poll>;
  __livePollVotesMem?: Map<string, Map<string, number>>;
};
const pollMem = (g.__livePollMem ??= new Map<string, Poll>());
const voteMem = (g.__livePollVotesMem ??= new Map<string, Map<string, number>>());

function newId(): string {
  return randomBytes(9).toString("base64url");
}

async function readPoll(slug: string): Promise<Poll | null> {
  const redis = await getRedis();
  if (redis) {
    try {
      const p = await redis.get<Poll>(pollKey(slug));
      return p && typeof p.id === "string" ? p : null;
    } catch {
      /* fall through */
    }
  }
  return pollMem.get(slug) ?? null;
}

async function writePoll(slug: string, poll: Poll): Promise<void> {
  pollMem.set(slug, poll);
  const redis = await getRedis();
  if (redis) {
    try {
      await redis.set(pollKey(slug), poll, { ex: TTL_S });
    } catch {
      /* best-effort */
    }
  }
}

/** The current poll (unfiltered — presenter view). */
export async function getActivePoll(slug: string): Promise<Poll | null> {
  return readPoll(slug);
}

/**
 * Open a NEW poll (replaces any current one and starts fresh votes). For a
 * branch vote pass kind:"branch" + branches parallel to options (the caller —
 * app/api/poll — derives options FROM the branch labels, so they stay 1:1; we
 * defensively trim to options.length after the empty-filter anyway).
 */
export async function openPoll(
  slug: string,
  input: {
    question: string;
    options: string[];
    correctIndex: number | null;
    kind?: PollKind;
    branches?: SlideBranch[];
  },
): Promise<Poll> {
  const options = input.options
    .map((o) => (o ?? "").toString().trim().slice(0, MAX_OPTION_LEN))
    .filter((o) => o.length > 0)
    .slice(0, MAX_OPTIONS);
  const correctIndex =
    typeof input.correctIndex === "number" &&
    Number.isInteger(input.correctIndex) &&
    input.correctIndex >= 0 &&
    input.correctIndex < options.length
      ? input.correctIndex
      : null;
  const kind: PollKind = input.kind === "branch" ? "branch" : "poll";
  const poll: Poll = {
    id: newId(),
    kind,
    question: (input.question ?? "").toString().trim().slice(0, MAX_QUESTION),
    options,
    correctIndex,
    revealed: false,
    tally: null,
    total: null,
    ...(kind === "branch" && input.branches
      ? { branches: input.branches.slice(0, options.length) }
      : {}),
    at: Date.now(),
  };
  await writePoll(slug, poll);
  // Fresh id → fresh votes; nothing to clear for this id. (Old ids TTL out.)
  voteMem.set(votesKey(slug, poll.id), new Map());
  return poll;
}

/** Record a viewer's vote. Rejects when there's no matching open (unrevealed) poll. */
export async function vote(
  slug: string,
  pollId: string,
  name: string,
  optionIndex: number,
): Promise<{ ok: boolean; error?: string }> {
  const poll = await readPoll(slug);
  if (!poll || poll.id !== pollId) return { ok: false, error: "no_poll" };
  if (poll.revealed) return { ok: false, error: "closed" };
  if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= poll.options.length) {
    return { ok: false, error: "bad_option" };
  }
  const redis = await getRedis();
  if (redis) {
    try {
      await redis.hset(votesKey(slug, poll.id), name, optionIndex);
      await redis.expire(votesKey(slug, poll.id), TTL_S);
      return { ok: true };
    } catch {
      /* fall through */
    }
  }
  let m = voteMem.get(votesKey(slug, poll.id));
  if (!m) {
    m = new Map();
    voteMem.set(votesKey(slug, poll.id), m);
  }
  m.set(name, optionIndex);
  return { ok: true };
}

async function tallyFor(slug: string, poll: Poll): Promise<{ tally: number[]; total: number }> {
  const counts = new Array(poll.options.length).fill(0);
  let total = 0;
  const redis = await getRedis();
  let votes: Record<string, number> | Map<string, number> | null = null;
  if (redis) {
    try {
      votes = await redis.hgetall<number>(votesKey(slug, poll.id));
    } catch {
      votes = null;
    }
  }
  if (!votes) votes = voteMem.get(votesKey(slug, poll.id)) ?? new Map();
  const values = votes instanceof Map ? Array.from(votes.values()) : Object.values(votes);
  for (const v of values) {
    const idx = Number(v);
    if (Number.isInteger(idx) && idx >= 0 && idx < counts.length) {
      counts[idx] += 1;
      total += 1;
    }
  }
  return { tally: counts, total };
}

/** The LIVE tally (presenter view, pre-reveal). */
export async function getLiveTally(slug: string): Promise<{ poll: Poll; tally: number[]; total: number } | null> {
  const poll = await readPoll(slug);
  if (!poll) return null;
  if (poll.revealed && poll.tally) return { poll, tally: poll.tally, total: poll.total ?? 0 };
  const { tally, total } = await tallyFor(slug, poll);
  return { poll, tally, total };
}

/** Freeze the tally and reveal the poll to viewers. */
export async function revealPoll(slug: string): Promise<Poll | null> {
  const poll = await readPoll(slug);
  if (!poll) return null;
  if (poll.revealed) return poll;
  const { tally, total } = await tallyFor(slug, poll);
  const revealed: Poll = { ...poll, revealed: true, tally, total };
  await writePoll(slug, revealed);
  return revealed;
}

/**
 * Attach the post-reveal "why that answer" note to the frozen poll so it rides
 * the existing session-poll delivery. Re-reads before writing so a poll that was
 * closed or replaced while the AI call ran is never resurrected — only the SAME
 * poll, still revealed, is updated. First write wins; best-effort like the rest.
 */
export async function setPollExplanation(
  slug: string,
  pollId: string,
  explanation: string,
): Promise<void> {
  const text = (explanation ?? "").toString().trim().slice(0, MAX_EXPLANATION);
  if (!text) return;
  const poll = await readPoll(slug);
  if (!poll || poll.id !== pollId || !poll.revealed || poll.explanation) return;
  await writePoll(slug, { ...poll, explanation: text });
}

/**
 * Record which branch the room was routed to (branch votes only). Mirrors
 * setPollExplanation's discipline: re-reads before writing so only the SAME,
 * still-revealed branch poll is updated — a vote replaced or closed while the
 * route ran is never resurrected. Unlike the explanation, a re-route OVERWRITES
 * (last route wins): untaken branches stay reachable and the presenter may
 * legitimately change course. Returns the updated poll, or null when no
 * matching branch poll was live.
 */
export async function setBranchTaken(
  slug: string,
  pollId: string,
  optionIndex: number,
): Promise<Poll | null> {
  const poll = await readPoll(slug);
  if (!poll || poll.id !== pollId || poll.kind !== "branch" || !poll.revealed) return null;
  if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= poll.options.length) {
    return null;
  }
  const next: Poll = { ...poll, takenIndex: optionIndex };
  await writePoll(slug, next);
  return next;
}

/** Close/clear the current poll (removes the overlay for viewers). */
export async function closePoll(slug: string): Promise<void> {
  pollMem.delete(slug);
  const redis = await getRedis();
  if (redis) {
    try {
      await redis.del(pollKey(slug));
    } catch {
      /* best-effort */
    }
  }
}

/** What a viewer may see (via the session poll): no correct answer/tally pre-reveal. */
export function pollForViewer(poll: Poll | null): ViewerPoll | null {
  if (!poll) return null;
  return {
    id: poll.id,
    kind: poll.kind ?? "poll",
    question: poll.question,
    options: poll.options,
    revealed: poll.revealed,
    correctIndex: poll.revealed ? poll.correctIndex : null,
    tally: poll.revealed ? poll.tally : null,
    total: poll.revealed ? poll.total : null,
    // Redundant with the reveal gate (the note is only ever written to a revealed
    // poll), but kept explicit: the explanation names the correct answer, so it
    // must be impossible to surface pre-reveal.
    explanation: poll.revealed ? (poll.explanation ?? null) : null,
    // The branch-route breadcrumb (only ever written post-reveal; gate anyway).
    takenIndex: poll.revealed && typeof poll.takenIndex === "number" ? poll.takenIndex : null,
    at: poll.at,
  };
}

/** Companion to clearSession — wipe poll state on deck delete. Best-effort. */
export async function clearPoll(slug: string): Promise<void> {
  await closePoll(slug);
}
