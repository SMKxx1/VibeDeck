// Upvotable Q&A queue (#5). Viewers post questions and upvote each other's; the
// presenter answers the top-voted and can dismiss noise. Reuses the Redis-hash
// pattern:
//   live:qna:<slug>            HASH qid -> {name, text, at, answered, dismissed}
//   live:qnacount:<slug>       HASH qid -> distinct-voter count (denormalized so
//                              the queue reads in TWO hgetalls regardless of size)
//   live:qnavoters:<slug>:<id> HASH name -> 1 (source of truth for one-vote-per-name)
// The count is derived from the per-question voters hash (per-field atomic), so
// concurrent upvotes converge without a lost-update read-modify-write on a count.

import { getRedis, hasRedis } from "./redis";
import { newId, requireRedis as requireSharedRedis } from "./redis-util";

export interface Question {
  id: string;
  name: string;
  text: string;
  votes: number;
  answered: boolean;
  dismissed: boolean;
  at: number;
}

interface QRecord {
  name: string;
  text: string;
  at: number;
  answered: boolean;
  dismissed: boolean;
}

export const MAX_QUESTIONS = 200;
export const MAX_TEXT = 400;
export const MAX_UPVOTES_PER_QUESTION = 1_000;

const qKey = (slug: string) => `live:qna:${slug}`;
const cKey = (slug: string) => `live:qnacount:${slug}`;
const vKey = (slug: string, id: string) => `live:qnavoters:${slug}:${id}`;
const TTL_S = 60 * 60 * 8;
const MEM_TTL_MS = TTL_S * 1000;
const MAX_MEM_ROOMS = 500;

const ADD_QUESTION_SCRIPT = `
if redis.call('HLEN', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
return 1
`;

const UPVOTE_SCRIPT = `
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 0 then return -1 end
local exists = redis.call('HEXISTS', KEYS[2], ARGV[2])
if exists == 0 and redis.call('HLEN', KEYS[2]) >= tonumber(ARGV[3]) then return -2 end
redis.call('HSET', KEYS[2], ARGV[2], 1)
local count = redis.call('HLEN', KEYS[2])
redis.call('HSET', KEYS[3], ARGV[1], count)
local ttl = tonumber(ARGV[4])
redis.call('EXPIRE', KEYS[1], ttl)
redis.call('EXPIRE', KEYS[2], ttl)
redis.call('EXPIRE', KEYS[3], ttl)
return count
`;

const PATCH_QUESTION_SCRIPT = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return 0 end
local ok, record = pcall(cjson.decode, raw)
if not ok or type(record) ~= 'table' then return 0 end
record[ARGV[2]] = ARGV[3] == '1'
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(record))
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
return 1
`;

const g = globalThis as unknown as {
  __qnaMem?: Map<string, Map<string, QRecord>>;
  __qnaVotesMem?: Map<string, Map<string, Set<string>>>; // slug -> qid -> voter names
  __qnaMemAt?: Map<string, number>;
};
const qMem = (g.__qnaMem ??= new Map<string, Map<string, QRecord>>());
const vMem = (g.__qnaVotesMem ??= new Map<string, Map<string, Set<string>>>());
const memAt = (g.__qnaMemAt ??= new Map<string, number>());

function cleanText(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
}

function sweepMemory(now: number): void {
  for (const [slug, questions] of qMem) {
    const fallbackAt = Math.max(0, ...Array.from(questions.values(), (record) => record.at));
    const at = memAt.get(slug) ?? fallbackAt;
    if (now - at >= MEM_TTL_MS) {
      qMem.delete(slug);
      vMem.delete(slug);
      memAt.delete(slug);
    }
  }
  while (qMem.size >= MAX_MEM_ROOMS) {
    const slug = qMem.keys().next().value as string | undefined;
    if (!slug) break;
    qMem.delete(slug);
    vMem.delete(slug);
    memAt.delete(slug);
  }
}

/** The shared store, or throw with THIS module's error code (lib/redis-util.ts). */
const requireRedis = () => requireSharedRedis("qna_store_unavailable");

/** Post a new question. Returns null when the queue is full. */
export async function addQuestion(
  slug: string,
  name: string,
  rawText: string,
): Promise<Question | null> {
  const text = cleanText(rawText);
  if (!text) return null;
  const rec: QRecord = { name: name.slice(0, 40) || "Someone", text, at: Date.now(), answered: false, dismissed: false };
  const id = newId();
  if (hasRedis()) {
    const redis = await requireRedis();
    const added = Number(
      await redis.eval<number>(
        ADD_QUESTION_SCRIPT,
        [qKey(slug)],
        [id, JSON.stringify(rec), MAX_QUESTIONS, TTL_S],
      ),
    );
    return added === 1 ? { id, ...rec, votes: 0 } : null;
  }
  sweepMemory(rec.at);
  let m = qMem.get(slug);
  if (!m) {
    m = new Map();
    qMem.set(slug, m);
  }
  if (m.size >= MAX_QUESTIONS) return null;
  m.set(id, rec);
  memAt.set(slug, rec.at);
  return { id, ...rec, votes: 0 };
}

/** Upvote (idempotent per name). Returns the new distinct-voter count. */
export async function upvote(
  slug: string,
  id: string,
  name: string,
): Promise<number | null | "full"> {
  if (hasRedis()) {
    const redis = await requireRedis();
    const result = Number(
      await redis.eval<number>(
        UPVOTE_SCRIPT,
        [qKey(slug), vKey(slug, id), cKey(slug)],
        [id, name, MAX_UPVOTES_PER_QUESTION, TTL_S],
      ),
    );
    if (result === -1) return null;
    if (result === -2) return "full";
    return result;
  }
  sweepMemory(Date.now());
  const qm = qMem.get(slug);
  if (!qm || !qm.has(id)) return null;
  let vm = vMem.get(slug);
  if (!vm) {
    vm = new Map();
    vMem.set(slug, vm);
  }
  let set = vm.get(id);
  if (!set) {
    set = new Set();
    vm.set(id, set);
  }
  if (!set.has(name) && set.size >= MAX_UPVOTES_PER_QUESTION) return "full";
  set.add(name);
  memAt.set(slug, Date.now());
  return set.size;
}

/** The queue, sorted by votes desc then oldest-first. `includeHidden` for presenter. */
export async function getQuestions(slug: string, includeHidden: boolean): Promise<Question[]> {
  let list: Question[] = [];
  if (hasRedis()) {
    const redis = await getRedis();
    try {
      if (!redis) return [];
      const [recs, counts] = await Promise.all([
        redis.hgetall<QRecord>(qKey(slug)),
        redis.hgetall<number>(cKey(slug)),
      ]);
      list = Object.entries(recs).map(([id, r]) => ({
        id,
        name: r.name,
        text: r.text,
        at: r.at,
        answered: !!r.answered,
        dismissed: !!r.dismissed,
        votes: Number(counts[id] ?? 0),
      }));
    } catch {
      list = []; // Redis blip → degrade to empty (same stance as the other reads)
    }
  } else {
    sweepMemory(Date.now());
    const qm = qMem.get(slug);
    const vm = vMem.get(slug);
    if (qm) {
      list = Array.from(qm.entries()).map(([id, r]) => ({
        id,
        name: r.name,
        text: r.text,
        at: r.at,
        answered: !!r.answered,
        dismissed: !!r.dismissed,
        votes: vm?.get(id)?.size ?? 0,
      }));
    }
  }
  if (!includeHidden) list = list.filter((q) => !q.dismissed);
  return list.sort((a, b) => b.votes - a.votes || a.at - b.at);
}

async function patch(slug: string, id: string, fields: Partial<QRecord>): Promise<boolean> {
  const field = fields.answered !== undefined ? "answered" : "dismissed";
  const value = field === "answered" ? fields.answered === true : fields.dismissed === true;
  if (hasRedis()) {
    const redis = await requireRedis();
    return (
      Number(
        await redis.eval<number>(
          PATCH_QUESTION_SCRIPT,
          [qKey(slug)],
          [id, field, value ? 1 : 0, TTL_S],
        ),
      ) === 1
    );
  }
  sweepMemory(Date.now());
  const qm = qMem.get(slug);
  const rec = qm?.get(id);
  if (!rec) return false;
  qm!.set(id, { ...rec, ...fields });
  memAt.set(slug, Date.now());
  return true;
}

export function setAnswered(slug: string, id: string, answered: boolean): Promise<boolean> {
  return patch(slug, id, { answered });
}
export function setDismissed(slug: string, id: string, dismissed: boolean): Promise<boolean> {
  return patch(slug, id, { dismissed });
}

/** Wipe the queue for a slug (companion to clearSession). Best-effort. */
export async function clearQna(slug: string): Promise<void> {
  qMem.delete(slug);
  vMem.delete(slug);
  memAt.delete(slug);
  if (!hasRedis()) return;
  const redis = await getRedis();
  if (redis) {
    try {
      await redis.del(qKey(slug));
      await redis.del(cKey(slug));
    } catch {
      /* best-effort; per-question voter keys TTL out */
    }
  }
}
