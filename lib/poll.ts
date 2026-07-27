// Live polls / knowledge-checks (#3). The presenter opens one multiple-choice
// question at a time; viewers vote; the presenter reveals the tally (and the
// correct answer, if any). Reuses the live-session Redis patterns:
//   live:poll:<slug>              — the current poll (JSON), or absent = none
//   live:pollvotes:<slug>:<id>    — a HASH of name → chosen option index
// One field per voter = per-field atomic writes (a viewer changing their vote
// overwrites their own field only). The final tally is FROZEN into the poll record
// at reveal time so viewers can see it via the cheap session poll without every
// request recomputing it; only the presenter reads the LIVE pre-reveal tally.

import { getRedis, hasRedis } from "./redis";
import { newId, requireRedis as requireSharedRedis } from "./redis-util";
import {
  invalidateSessionCache,
  setPresenterIndexMemoryOnly,
  type SessionState,
} from "./session";
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
export const MAX_VOTES = 1_000;
const MAX_EXPLANATION = 1200; // explanations are short model answers — a hard backstop

const pollKey = (slug: string) => `live:poll:${slug}`;
const votesKey = (slug: string, id: string) => `live:pollvotes:${slug}:${id}`;
const sessionKey = (slug: string) => `live:session:${slug}`;
const TTL_S = 60 * 60 * 8;
const SESSION_TTL_S = 60 * 60 * 8;
const MEM_TTL_MS = TTL_S * 1000;
const MAX_MEM_POLLS = 500;
const MAX_MEM_VOTE_BUCKETS = 1_000;

const VOTE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ok, poll = pcall(cjson.decode, raw)
if not ok or type(poll) ~= 'table' or poll.id ~= ARGV[1] then return 0 end
if poll.revealed == true then return 1 end
local optionIndex = tonumber(ARGV[3])
local optionCount = type(poll.options) == 'table' and #poll.options or 0
if not optionIndex or optionIndex < 0 or optionIndex >= optionCount or optionIndex ~= math.floor(optionIndex) then
  return 2
end
local exists = redis.call('HEXISTS', KEYS[2], ARGV[2])
if exists == 0 and redis.call('HLEN', KEYS[2]) >= tonumber(ARGV[4]) then return 3 end
redis.call('HSET', KEYS[2], ARGV[2], optionIndex)
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[5]))
return 4
`;

const REVEAL_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {-2, ''} end
local ok, poll = pcall(cjson.decode, raw)
if not ok or type(poll) ~= 'table' then return {-2, ''} end
if poll.id ~= ARGV[1] then return {-1, ''} end
if poll.revealed == true then return {0, raw} end

local optionCount = type(poll.options) == 'table' and #poll.options or 0
local tally = {}
for i = 1, optionCount do tally[i] = 0 end
local total = 0
local limit = tonumber(ARGV[3])
local stored = redis.call('HLEN', KEYS[2])
local processed = 0
local scanned = 0
local seen = {}
local cursor = '0'
repeat
  local page = redis.call('HSCAN', KEYS[2], cursor, 'COUNT', 200)
  cursor = page[1]
  local values = page[2]
  for i = 2, #values, 2 do
    scanned = scanned + 1
    local voter = values[i - 1]
    if not seen[voter] and processed < limit then
      seen[voter] = true
      processed = processed + 1
      local index = tonumber(values[i])
      if index and index == math.floor(index) and index >= 0 and index < optionCount then
        tally[index + 1] = tally[index + 1] + 1
        total = total + 1
      end
    end
    if stored > limit and (processed >= limit or scanned >= limit * 2) then break end
  end
until cursor == '0' or (stored > limit and (processed >= limit or scanned >= limit * 2))
poll.revealed = true
poll.tally = tally
poll.total = total
local encoded = cjson.encode(poll)
redis.call('SET', KEYS[1], encoded, 'EX', tonumber(ARGV[2]))
return {1, encoded}
`;

const TALLY_SCRIPT = `
local optionCount = tonumber(ARGV[1])
local tally = {}
for i = 1, optionCount do tally[i] = 0 end
local total = 0
local limit = tonumber(ARGV[2])
local stored = redis.call('HLEN', KEYS[1])
local processed = 0
local scanned = 0
local seen = {}
local cursor = '0'
repeat
  local page = redis.call('HSCAN', KEYS[1], cursor, 'COUNT', 200)
  cursor = page[1]
  local values = page[2]
  for i = 2, #values, 2 do
    scanned = scanned + 1
    local voter = values[i - 1]
    if not seen[voter] and processed < limit then
      seen[voter] = true
      processed = processed + 1
      local index = tonumber(values[i])
      if index and index == math.floor(index) and index >= 0 and index < optionCount then
        tally[index + 1] = tally[index + 1] + 1
        total = total + 1
      end
    end
    if stored > limit and (processed >= limit or scanned >= limit * 2) then break end
  end
until cursor == '0' or (stored > limit and (processed >= limit or scanned >= limit * 2))
return cjson.encode({tally = tally, total = total})
`;

const PATCH_CURRENT_POLL_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return '' end
local ok, poll = pcall(cjson.decode, raw)
if not ok or type(poll) ~= 'table' or poll.id ~= ARGV[2] or poll.revealed ~= true then
  return ''
end
if ARGV[1] == 'explanation' then
  if type(poll.explanation) == 'string' and poll.explanation ~= '' then return raw end
  poll.explanation = ARGV[3]
elseif ARGV[1] == 'branch' then
  if poll.kind ~= 'branch' or type(poll.options) ~= 'table' then return '' end
  local optionIndex = tonumber(ARGV[3])
  if not optionIndex or optionIndex ~= math.floor(optionIndex) or optionIndex < 0 or optionIndex >= #poll.options then
    return ''
  end
  poll.takenIndex = optionIndex
else
  return redis.error_reply('unknown poll patch')
end
local encoded = cjson.encode(poll)
redis.call('SET', KEYS[1], encoded, 'EX', tonumber(ARGV[4]))
return encoded
`;

const ROUTE_BRANCH_SCRIPT = `
local pollRaw = redis.call('GET', KEYS[1])
if not pollRaw then return {0, '', ''} end
local pollOk, poll = pcall(cjson.decode, pollRaw)
if not pollOk or type(poll) ~= 'table' or poll.id ~= ARGV[1] or poll.kind ~= 'branch' or poll.revealed ~= true then
  return {0, '', ''}
end
local optionIndex = tonumber(ARGV[2])
if not optionIndex or optionIndex ~= math.floor(optionIndex) or optionIndex < 0 or type(poll.options) ~= 'table' or optionIndex >= #poll.options then
  return {0, '', ''}
end

local sessionRaw = redis.call('GET', KEYS[2])
local state = { index = 0, max = 0, updatedAt = 0, seenAt = 0 }
if sessionRaw then
  local sessionOk, decoded = pcall(cjson.decode, sessionRaw)
  if sessionOk and type(decoded) == 'table' then state = decoded end
end
state.index = math.max(0, math.floor(tonumber(state.index) or 0))
state.max = math.max(0, math.floor(tonumber(state.max) or state.index))
state.updatedAt = tonumber(state.updatedAt) or 0
state.seenAt = tonumber(state.seenAt) or 0
if type(state.driverId) ~= 'string' or state.driverId == '' then state.driverId = nil end

local driverId = ARGV[4]
if driverId ~= '' and state.driverId and state.driverId ~= driverId then
  return {1, pollRaw, cjson.encode(state)}
end

local targetIndex = math.max(0, math.floor(tonumber(ARGV[3]) or 0))
local now = tonumber(ARGV[5])
state.index = targetIndex
state.max = math.max(state.max, targetIndex)
state.updatedAt = now
state.seenAt = now
if not state.driverId and driverId ~= '' then state.driverId = driverId end
poll.takenIndex = optionIndex

local encodedPoll = cjson.encode(poll)
local encodedState = cjson.encode(state)
redis.call('SET', KEYS[1], encodedPoll, 'EX', tonumber(ARGV[6]))
redis.call('SET', KEYS[2], encodedState, 'EX', tonumber(ARGV[7]))
return {2, encodedPoll, encodedState}
`;

interface VoteBucket {
  at: number;
  votes: Map<string, number>;
}

const g = globalThis as unknown as {
  __livePollMem?: Map<string, Poll>;
  __livePollVotesMem?: Map<string, VoteBucket>;
};
const pollMem = (g.__livePollMem ??= new Map<string, Poll>());
const voteMem = (g.__livePollVotesMem ??= new Map<string, VoteBucket>());

function parsePoll(raw: unknown): Poll | null {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const poll = value as Partial<Poll> | null;
  return poll && typeof poll.id === "string" && Array.isArray(poll.options)
    ? (poll as Poll)
    : null;
}

function parseSessionState(raw: unknown): SessionState | null {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const state = value as Partial<SessionState>;
  if (typeof state.index !== "number") return null;
  return {
    index: Math.max(0, Math.floor(state.index)),
    max: Math.max(0, Math.floor(typeof state.max === "number" ? state.max : state.index)),
    updatedAt: typeof state.updatedAt === "number" ? state.updatedAt : 0,
    seenAt: typeof state.seenAt === "number" ? state.seenAt : 0,
    ...(typeof state.driverId === "string" && state.driverId
      ? { driverId: state.driverId }
      : {}),
  };
}

function memoryPoll(slug: string, now = Date.now()): Poll | null {
  const poll = pollMem.get(slug) ?? null;
  if (poll && now - poll.at >= MEM_TTL_MS) {
    pollMem.delete(slug);
    voteMem.delete(votesKey(slug, poll.id));
    return null;
  }
  return poll;
}

function memoryBucket(key: string, create = false): VoteBucket | null {
  const raw = voteMem.get(key) as VoteBucket | Map<string, number> | undefined;
  // Accommodate a pre-change bucket retained by Next dev hot reload.
  if (raw instanceof Map) {
    const converted = { at: Date.now(), votes: raw };
    voteMem.set(key, converted);
    return converted;
  }
  if (raw) return raw;
  if (!create) return null;
  const bucket = { at: Date.now(), votes: new Map<string, number>() };
  voteMem.set(key, bucket);
  return bucket;
}

function sweepMemory(now = Date.now()): void {
  for (const [slug, poll] of pollMem) {
    if (now - poll.at >= MEM_TTL_MS) {
      pollMem.delete(slug);
      voteMem.delete(votesKey(slug, poll.id));
    }
  }
  for (const key of voteMem.keys()) {
    const normalized = memoryBucket(key);
    if (!normalized || now - normalized.at >= MEM_TTL_MS) voteMem.delete(key);
  }
  while (pollMem.size >= MAX_MEM_POLLS) {
    const slug = pollMem.keys().next().value as string | undefined;
    if (!slug) break;
    const poll = pollMem.get(slug);
    pollMem.delete(slug);
    if (poll) voteMem.delete(votesKey(slug, poll.id));
  }
  while (voteMem.size >= MAX_MEM_VOTE_BUCKETS) {
    const key = voteMem.keys().next().value as string | undefined;
    if (!key) break;
    voteMem.delete(key);
  }
}

/** The shared store, or throw with THIS module's error code (lib/redis-util.ts). */
const requireRedis = () => requireSharedRedis("poll_store_unavailable");

async function readPoll(slug: string): Promise<Poll | null> {
  if (!hasRedis()) return memoryPoll(slug);
  const redis = await getRedis();
  if (redis) {
    try {
      const p = await redis.get<Poll>(pollKey(slug));
      return p && typeof p.id === "string" ? p : null;
    } catch {
      return null;
    }
  }
  return null;
}

async function writePoll(slug: string, poll: Poll): Promise<void> {
  if (!hasRedis()) {
    sweepMemory();
    const previous = memoryPoll(slug);
    if (previous) voteMem.delete(votesKey(slug, previous.id));
    pollMem.set(slug, poll);
    return;
  }
  const redis = await requireRedis();
  await redis.set(pollKey(slug), poll, { ex: TTL_S });
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
  if (!hasRedis()) memoryBucket(votesKey(slug, poll.id), true);
  return poll;
}

/** Record a viewer's vote. Rejects when there's no matching open (unrevealed) poll. */
export async function vote(
  slug: string,
  pollId: string,
  name: string,
  optionIndex: number,
): Promise<{ ok: boolean; error?: string }> {
  if (!hasRedis()) {
    const poll = memoryPoll(slug);
    if (!poll || poll.id !== pollId) return { ok: false, error: "no_poll" };
    if (poll.revealed) return { ok: false, error: "closed" };
    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= poll.options.length) {
      return { ok: false, error: "bad_option" };
    }
    const bucket = memoryBucket(votesKey(slug, poll.id), true)!;
    if (!bucket.votes.has(name) && bucket.votes.size >= MAX_VOTES) {
      return { ok: false, error: "full" };
    }
    bucket.votes.set(name, optionIndex);
    bucket.at = Date.now();
    return { ok: true };
  }

  const redis = await requireRedis();
  const code = Number(
    await redis.eval<number>(
      VOTE_SCRIPT,
      [pollKey(slug), votesKey(slug, pollId)],
      [pollId, name, optionIndex, MAX_VOTES, TTL_S],
    ),
  );
  if (code === 4) return { ok: true };
  if (code === 1) return { ok: false, error: "closed" };
  if (code === 2) return { ok: false, error: "bad_option" };
  if (code === 3) return { ok: false, error: "full" };
  return { ok: false, error: "no_poll" };
}

async function tallyFor(slug: string, poll: Poll): Promise<{ tally: number[]; total: number }> {
  const counts = new Array(poll.options.length).fill(0);
  let total = 0;
  let votes: Record<string, number> | Map<string, number> = new Map();
  if (hasRedis()) {
    const redis = await getRedis();
    try {
      if (redis) {
        const raw = await redis.eval<string>(
          TALLY_SCRIPT,
          [votesKey(slug, poll.id)],
          [poll.options.length, MAX_VOTES],
        );
        const parsed = JSON.parse(raw) as { tally?: unknown; total?: unknown };
        if (
          Array.isArray(parsed.tally) &&
          parsed.tally.length === counts.length &&
          typeof parsed.total === "number"
        ) {
          return {
            tally: parsed.tally.map((value) => Math.max(0, Number(value) || 0)),
            total: Math.max(0, parsed.total),
          };
        }
      }
    } catch {
      votes = new Map();
    }
  } else {
    votes = memoryBucket(votesKey(slug, poll.id))?.votes ?? new Map();
  }
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

export interface RevealPollResult {
  poll: Poll;
  /** True only for the request that atomically changed open → revealed. */
  revealedNow: boolean;
}

/** Freeze the tally and reveal the poll to viewers in one atomic transition. */
export async function revealPollWithStatus(slug: string): Promise<RevealPollResult | null> {
  if (!hasRedis()) {
    const poll = memoryPoll(slug);
    if (!poll) return null;
    if (poll.revealed) return { poll, revealedNow: false };
    const counts = new Array(poll.options.length).fill(0);
    let total = 0;
    const bucket = memoryBucket(votesKey(slug, poll.id));
    for (const value of bucket?.votes.values() ?? []) {
      if (Number.isInteger(value) && value >= 0 && value < counts.length) {
        counts[value] += 1;
        total += 1;
      }
    }
    const revealed = { ...poll, revealed: true, tally: counts, total };
    pollMem.set(slug, revealed);
    return { poll: revealed, revealedNow: true };
  }

  const redis = await requireRedis();
  // We need the current id to name its vote hash. The script re-checks that id
  // atomically, and retries if a concurrent open replaced the poll in between.
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = parsePoll(await redis.get<Poll>(pollKey(slug)));
    if (!current) return null;
    const result = await redis.eval<[number, string]>(
      REVEAL_SCRIPT,
      [pollKey(slug), votesKey(slug, current.id)],
      [current.id, TTL_S, MAX_VOTES],
    );
    const status = Number(result?.[0]);
    if (status === -1) continue;
    if (status === -2) return null;
    const poll = parsePoll(result?.[1]);
    if (!poll) throw new Error("poll_reveal_state_unavailable");
    return { poll, revealedNow: status === 1 };
  }
  throw new Error("poll_changed_during_reveal");
}

/** Backward-compatible poll-only projection. */
export async function revealPoll(slug: string): Promise<Poll | null> {
  return (await revealPollWithStatus(slug))?.poll ?? null;
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
  if (!hasRedis()) {
    const poll = memoryPoll(slug);
    if (!poll || poll.id !== pollId || !poll.revealed || poll.explanation) return;
    pollMem.set(slug, { ...poll, explanation: text });
    return;
  }
  const redis = await requireRedis();
  await redis.eval<string>(
    PATCH_CURRENT_POLL_SCRIPT,
    [pollKey(slug)],
    ["explanation", pollId, text, TTL_S],
  );
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
  if (!Number.isInteger(optionIndex) || optionIndex < 0) return null;
  if (!hasRedis()) {
    const poll = memoryPoll(slug);
    if (!poll || poll.id !== pollId || poll.kind !== "branch" || !poll.revealed) return null;
    if (optionIndex >= poll.options.length) return null;
    const next: Poll = { ...poll, takenIndex: optionIndex };
    pollMem.set(slug, next);
    return next;
  }
  const redis = await requireRedis();
  const raw = await redis.eval<string>(
    PATCH_CURRENT_POLL_SCRIPT,
    [pollKey(slug)],
    ["branch", pollId, optionIndex, TTL_S],
  );
  return raw ? parsePoll(raw) : null;
}

export interface RouteBranchResult {
  poll: Poll;
  state: SessionState;
  /** False when a different presenter currently owns the clicker. */
  routed: boolean;
}

/**
 * Move the room and record the chosen branch as one guarded transition. The
 * current poll id/reveal state and clicker ownership are checked at commit time,
 * so a concurrent poll replacement can never route from stale branch data.
 */
export async function routeBranch(
  slug: string,
  pollId: string,
  optionIndex: number,
  targetIndex: number,
  driverId: string,
): Promise<RouteBranchResult | null> {
  if (
    !Number.isInteger(optionIndex) ||
    optionIndex < 0 ||
    !Number.isInteger(targetIndex) ||
    targetIndex < 0 ||
    targetIndex > 10_000
  ) {
    return null;
  }

  if (!hasRedis()) {
    const poll = memoryPoll(slug);
    if (
      !poll ||
      poll.id !== pollId ||
      poll.kind !== "branch" ||
      !poll.revealed ||
      optionIndex >= poll.options.length
    ) {
      return null;
    }

    // Both mutations below are synchronous and therefore indivisible in the
    // single-process fallback. A rejected clicker write leaves the poll alone.
    const state = setPresenterIndexMemoryOnly(slug, targetIndex, driverId);
    const routed = (!state.driverId || state.driverId === driverId) && state.index === targetIndex;
    if (!routed) return { poll, state, routed: false };
    const updated: Poll = { ...poll, takenIndex: optionIndex };
    pollMem.set(slug, updated);
    return { poll: updated, state, routed: true };
  }

  const redis = await requireRedis();
  const result = await redis.eval<[number, string, string]>(
    ROUTE_BRANCH_SCRIPT,
    [pollKey(slug), sessionKey(slug)],
    [pollId, optionIndex, targetIndex, driverId, Date.now(), TTL_S, SESSION_TTL_S],
  );
  const status = Number(result?.[0]);
  if (status === 0) return null;
  const poll = parsePoll(result?.[1]);
  const state = parseSessionState(result?.[2]);
  if (!poll || !state || (status !== 1 && status !== 2)) {
    throw new Error("branch_route_state_unavailable");
  }
  invalidateSessionCache(slug);
  return { poll, state, routed: status === 2 };
}

/** Close/clear the current poll (removes the overlay for viewers). */
export async function closePoll(slug: string): Promise<void> {
  if (!hasRedis()) {
    const poll = memoryPoll(slug);
    pollMem.delete(slug);
    if (poll) voteMem.delete(votesKey(slug, poll.id));
    return;
  }
  const redis = await requireRedis();
  await redis.del(pollKey(slug));
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
  const memory = memoryPoll(slug);
  pollMem.delete(slug);
  if (memory) voteMem.delete(votesKey(slug, memory.id));
  if (!hasRedis()) return;
  const redis = await getRedis();
  if (!redis) return;
  try {
    const current = parsePoll(await redis.get<Poll>(pollKey(slug)));
    await redis.del(pollKey(slug));
    if (current) await redis.del(votesKey(slug, current.id));
  } catch {
    /* deletion cleanup is best-effort; vote keys retain their finite TTL */
  }
}
