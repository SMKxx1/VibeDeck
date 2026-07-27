// Two primitives every live-room store needs (server-only). Both were
// byte-identical copies sitting in lib/poll.ts, lib/qna.ts, lib/presence.ts,
// lib/recap.ts and lib/activity.ts; they live here so there is ONE definition to
// reason about rather than five that can silently drift apart.

import { randomBytes } from "crypto";
import { getRedis, type RedisClient } from "./redis";

/**
 * The shared store, or throw. Used by the write paths that must NOT degrade to a
 * per-instance memory fallback — a vote or a question only one server instance
 * can see is worse than a visible failure. The error code stays the CALLER's:
 * each store throws its own `<domain>_store_unavailable`, which the API layer
 * maps to a 503 and which keeps the log line diagnosable.
 */
export async function requireRedis(errorCode: string): Promise<RedisClient> {
  const redis = await getRedis();
  if (!redis) throw new Error(errorCode);
  return redis;
}

/**
 * A short urlsafe id for a live-room record (poll, question, recap, activity).
 * 9 random bytes → exactly 12 base64url characters with no padding. These are
 * opaque handles scoped to one 8h room — not secrets, not durable identifiers.
 */
export function newId(): string {
  return randomBytes(9).toString("base64url");
}
