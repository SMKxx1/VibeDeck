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

export interface Poll {
  id: string;
  question: string;
  options: string[];
  correctIndex: number | null; // null = opinion poll (no right answer)
  revealed: boolean;
  tally: number[] | null; // frozen at reveal
  total: number | null; // frozen at reveal
  at: number;
}

// What a VIEWER is allowed to see: never the correct answer or tally until reveal.
export interface ViewerPoll {
  id: string;
  question: string;
  options: string[];
  revealed: boolean;
  correctIndex: number | null;
  tally: number[] | null;
  total: number | null;
  at: number;
}

export const MAX_OPTIONS = 8;
export const MAX_QUESTION = 400;
export const MAX_OPTION_LEN = 200;

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

/** Open a NEW poll (replaces any current one and starts fresh votes). */
export async function openPoll(
  slug: string,
  input: { question: string; options: string[]; correctIndex: number | null },
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
  const poll: Poll = {
    id: newId(),
    question: (input.question ?? "").toString().trim().slice(0, MAX_QUESTION),
    options,
    correctIndex,
    revealed: false,
    tally: null,
    total: null,
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
    question: poll.question,
    options: poll.options,
    revealed: poll.revealed,
    correctIndex: poll.revealed ? poll.correctIndex : null,
    tally: poll.revealed ? poll.tally : null,
    total: poll.revealed ? poll.total : null,
    at: poll.at,
  };
}

/** Companion to clearSession — wipe poll state on deck delete. Best-effort. */
export async function clearPoll(slug: string): Promise<void> {
  await closePoll(slug);
}
