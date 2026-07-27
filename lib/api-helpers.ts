// The small, policy-free primitives the API layer kept re-declaring. Roughly
// thirty route handlers each carried a byte-identical private copy of these three,
// which meant a change to (say) the display-name charset was a grep-and-pray edit
// across the whole surface instead of one line here.
//
// Deliberately narrow: nothing in this module decides WHO may do something (that's
// lib/auth.ts) or touches a store. Response construction stays in the routes —
// their bodies vary field by field (retryAfter, issues, warnings, statusMap), so a
// shared jsonError() would take more arguments than the NextResponse.json call it
// replaced and would quietly invite those bodies to drift.

/**
 * The cache header every live/polled endpoint sends. Those responses are
 * per-request room state (position, roster, tally, signals) — a cached one is
 * actively wrong, not merely stale, so they opt out rather than negotiate.
 */
export const NO_STORE = { "cache-control": "no-store" } as const;

/**
 * Bound `n` to [lo, hi]. Used to pin a client-supplied slide index into the deck's
 * real range before it indexes a slides array or lands in a prompt.
 */
export function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Normalize a viewer-supplied display name. This is BOTH a prompt-safety and a
 * key-safety rule, which is why every viewer route must apply the same one:
 *
 *  - the name is rendered into AI system messages and "=====" block headers, so
 *    stray quotes, newlines, or fence characters could forge the data/instruction
 *    boundary — the charset keeps letters, numbers, spaces, and light punctuation;
 *  - the name is also a rate-limit and vote-identity key component, so two routes
 *    disagreeing on the normalization would hand the same person two buckets.
 *
 * Non-string input is coerced (`(raw ?? "").toString()`) rather than rejected: the
 * body is untrusted JSON, and a numeric name is a client bug, not an attack.
 */
export function cleanName(raw: unknown): string {
  return (
    (raw ?? "")
      .toString()
      .replace(/[^\p{L}\p{N} .,'-]/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 40) || "anonymous"
  );
}
