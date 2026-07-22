// Shared optional Postgres accessor (server-only).
//
// Backed by a standard Postgres reached through `DATABASE_URL` — e.g. a Railway
// Postgres via its private host (postgres.railway.internal) in prod, or its
// public TCP proxy (…proxy.rlwy.net) for local dev. If `DATABASE_URL` is absent,
// this returns null and every caller falls back to the static slide context /
// embed-deck notes, so the app runs locally with zero setup and lights up the
// moment a real URL is added. `pg` is imported dynamically so a deploy without
// it (or without a DB) never fails to build. This module is server-only — never
// import it from a "use client" component.

import dns from "node:dns";
import type { Pool, QueryResult, QueryResultRow } from "pg";

// Railway's private-network Postgres host (postgres.railway.internal) publishes
// ONLY AAAA (IPv6) records, and Node's default DNS result order can fail to
// connect to an IPv6-only host in some environments. Prefer IPv6 when a host
// resolves to both families. This changes ORDERING ONLY — a host that resolves
// to IPv4 only (e.g. the public DATABASE_PUBLIC_URL proxy) still returns its
// IPv4 address, so that path is unaffected. Module-level: runs once per process.
dns.setDefaultResultOrder("ipv6first");

// One-shot incident signal: a DB that is CONFIGURED (DATABASE_URL set) but
// unreachable is unexpected and otherwise invisible (every caller degrades
// silently). Surface it once per process — never per failed query — and never
// log the connection string / password.
let dbUnreachableLogged = false;
function logDbUnreachableOnce(err: unknown): void {
  if (dbUnreachableLogged) return;
  if (!process.env.DATABASE_URL) return; // normal "no DB" case — not an incident
  dbUnreachableLogged = true;
  const message = err instanceof Error ? err.message : String(err);
  console.error("[db] DATABASE_URL is set but the database is unreachable:", message);
}

let poolPromise: Promise<Pool | null> | null = null;

// Railway's private network host speaks plaintext inside the project. Every
// public connection must authenticate the server certificate; DATABASE_CA_CERT
// supports providers using a private CA (literal PEM or base64-encoded PEM).
function sslFor(url: string): false | { rejectUnauthorized: true; ca?: string } {
  try {
    const host = new URL(url).hostname;
    if (host.endsWith(".railway.internal")) return false;
  } catch {
    /* The pool will surface the malformed URL without exposing it in logs. */
  }
  const configuredCa = process.env.DATABASE_CA_CERT?.trim();
  if (!configuredCa) return { rejectUnauthorized: true };
  const ca = configuredCa.includes("BEGIN CERTIFICATE")
    ? configuredCa.replace(/\\n/g, "\n")
    : Buffer.from(configuredCa, "base64").toString("utf8");
  return { rejectUnauthorized: true, ca };
}

function poolSize(): number {
  const parsed = Number(process.env.DATABASE_POOL_MAX ?? 5);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 20 ? parsed : 5;
}

/** The shared pool, or null when no `DATABASE_URL` is configured / pg is absent. */
export function getPool(): Promise<Pool | null> {
  if (!process.env.DATABASE_URL) return Promise.resolve(null);
  if (!poolPromise) {
    poolPromise = (async () => {
      try {
        const url = process.env.DATABASE_URL as string;
        const { Pool } = await import("pg");
        const pool = new Pool({
          connectionString: url,
          ssl: sslFor(url),
          // Serverless-friendly: a small pool per warm instance, drop idle
          // clients quickly, and fail fast if the DB is unreachable.
          max: poolSize(),
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 5_000,
          query_timeout: 15_000,
          statement_timeout: 15_000,
          lock_timeout: 5_000,
          idle_in_transaction_session_timeout: 15_000,
          application_name: "vibedeck-web",
        });
        pool.on("error", logDbUnreachableOnce);
        return pool;
      } catch (err) {
        logDbUnreachableOnce(err);
        return null; // package not installed / bad URL — degrade gracefully
      }
    })();
  }
  return poolPromise;
}

/** True when a real Postgres is configured (used to distinguish "DB down"). */
export function hasDb(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

// Reachability probe cache. `hasDb()` only proves DATABASE_URL is SET, not that
// Postgres answers — so a real outage masquerades as "this deck has no slides".
// `isDbReachable()` actually pings the DB, but callers live in hot paths (admin
// GET/PUT, the edit page render), so we memoize the boolean for a few seconds:
// a stale-for-a-moment signal is fine, a round-trip per request is not. Cache is
// process-scoped and holds true OR false — a flapping DB won't hammer it either way.
const REACHABLE_TTL_MS = 12_000;
let reachableCache: { value: boolean; at: number } | null = null;

/**
 * Whether Postgres is genuinely REACHABLE right now (not merely configured).
 * Returns false immediately when DATABASE_URL is unset (the normal "no DB" case,
 * not an incident). Otherwise runs a trivial `SELECT 1` against the shared pool
 * with a short timeout, caching the result for a few seconds. Use this — not
 * `hasDb()` — anywhere the outcome tells a human "database unavailable", so a
 * real outage surfaces instead of degrading silently.
 */
export async function isDbReachable(): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;

  const now = Date.now();
  if (reachableCache && now - reachableCache.at < REACHABLE_TTL_MS) {
    return reachableCache.value;
  }

  let value = false;
  try {
    const pool = await getPool();
    if (pool) {
      // Race the ping against a short timeout so a hung connection can't stall
      // the caller for the full pool connectionTimeoutMillis.
      await Promise.race([
        pool.query("SELECT 1"),
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error("db_ping_timeout")), 3_000),
        ),
      ]);
      value = true;
    }
  } catch (err) {
    logDbUnreachableOnce(err);
    value = false;
  }

  reachableCache = { value, at: now };
  return value;
}

/** Sentinel thrown when a query is attempted with no database available. */
export class NoDatabaseError extends Error {
  constructor() {
    super("no_database");
    this.name = "NoDatabaseError";
  }
}

/**
 * Run a parameterized query. Throws `NoDatabaseError` when no pool is available
 * (so the store layer can catch it and fall back), and propagates real query
 * errors for the store layer to catch too. Kept minimal on purpose.
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  const pool = await getPool();
  if (!pool) throw new NoDatabaseError();
  return pool.query<T>(text, params as never);
}
