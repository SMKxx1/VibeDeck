// Upvotable Q&A queue (#5). Viewers post questions and upvote each other's; the
// presenter answers the top-voted and can dismiss noise. Reuses the Redis-hash
// pattern:
//   live:qna:<slug>            HASH qid -> {name, text, at, answered, dismissed}
//   live:qnacount:<slug>       HASH qid -> distinct-voter count (denormalized so
//                              the queue reads in TWO hgetalls regardless of size)
//   live:qnavoters:<slug>:<id> HASH name -> 1 (source of truth for one-vote-per-name)
// The count is derived from the per-question voters hash (per-field atomic), so
// concurrent upvotes converge without a lost-update read-modify-write on a count.

import { randomBytes } from "crypto";
import { getRedis } from "./redis";

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

const qKey = (slug: string) => `live:qna:${slug}`;
const cKey = (slug: string) => `live:qnacount:${slug}`;
const vKey = (slug: string, id: string) => `live:qnavoters:${slug}:${id}`;
const TTL_S = 60 * 60 * 8;

const g = globalThis as unknown as {
  __qnaMem?: Map<string, Map<string, QRecord>>;
  __qnaVotesMem?: Map<string, Map<string, Set<string>>>; // slug -> qid -> voter names
};
const qMem = (g.__qnaMem ??= new Map<string, Map<string, QRecord>>());
const vMem = (g.__qnaVotesMem ??= new Map<string, Map<string, Set<string>>>());

function newId(): string {
  return randomBytes(9).toString("base64url");
}
function cleanText(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
}

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
  const redis = await getRedis();
  if (redis) {
    try {
      const existing = await redis.hgetall<QRecord>(qKey(slug));
      if (Object.keys(existing).length >= MAX_QUESTIONS) return null;
      await redis.hset(qKey(slug), id, rec);
      await redis.expire(qKey(slug), TTL_S);
      return { id, ...rec, votes: 0 };
    } catch {
      /* fall through */
    }
  }
  let m = qMem.get(slug);
  if (!m) {
    m = new Map();
    qMem.set(slug, m);
  }
  if (m.size >= MAX_QUESTIONS) return null;
  m.set(id, rec);
  return { id, ...rec, votes: 0 };
}

/** Upvote (idempotent per name). Returns the new distinct-voter count. */
export async function upvote(slug: string, id: string, name: string): Promise<number | null> {
  const redis = await getRedis();
  if (redis) {
    try {
      const q = await redis.hgetall<QRecord>(qKey(slug));
      if (!q[id]) return null; // no such question
      await redis.hset(vKey(slug, id), name, 1);
      await redis.expire(vKey(slug, id), TTL_S);
      const voters = await redis.hgetall<number>(vKey(slug, id));
      const count = Object.keys(voters).length;
      await redis.hset(cKey(slug), id, count);
      await redis.expire(cKey(slug), TTL_S);
      return count;
    } catch {
      /* fall through */
    }
  }
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
  set.add(name);
  return set.size;
}

/** The queue, sorted by votes desc then oldest-first. `includeHidden` for presenter. */
export async function getQuestions(slug: string, includeHidden: boolean): Promise<Question[]> {
  const redis = await getRedis();
  let list: Question[] = [];
  if (redis) {
    try {
      const recs = await redis.hgetall<QRecord>(qKey(slug));
      const counts = await redis.hgetall<number>(cKey(slug));
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
  const redis = await getRedis();
  if (redis) {
    try {
      const q = await redis.hgetall<QRecord>(qKey(slug));
      const rec = q[id];
      if (!rec) return false;
      await redis.hset(qKey(slug), id, { ...rec, ...fields });
      return true;
    } catch {
      /* fall through */
    }
  }
  const qm = qMem.get(slug);
  const rec = qm?.get(id);
  if (!rec) return false;
  qm!.set(id, { ...rec, ...fields });
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
