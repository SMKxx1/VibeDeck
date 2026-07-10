// Serve-time transform for uploaded decks (server-only, Phase 2).
//
// An uploaded deck's STORED html is just the author's <deck-stage> + <section>
// slides (+ optional inline scripts + an optional JSON context manifest). It
// carries NO slide runtime of its own. At serve time we inline-inject the shared
// versioned platform runtime (runtime/vibedeck-v1.js = the <deck-stage> engine +
// the live bridge) so every uploaded deck renders and reports slide changes
// consistently, and authors never have to reference (or mis-reference) a runtime.
//
// WHY INLINE (not <script src>): the deck is served on the isolated DECK_ORIGIN
// under a strict CSP inside a `sandbox allow-scripts` (opaque-origin) frame. In
// an opaque-origin document `'self'` is an unreliable script-src match, so a
// <script src> to the runtime URL is fragile — whereas the CSP ALREADY allows
// `'unsafe-inline'`, so an inline <script> runs with no CSP change, no extra
// origin in script-src, no middleware route, and no cacheable-runtime-can't-be-
// hotfixed problem. The runtime body (~90KB) is trivial next to the 2MB deck cap
// and the response is no-store anyway. This transform is the SINGLE place the
// runtime is added, and lib/deck-validator validates the author's stored html
// while the client boot-check exercises this exact served form — so stored and
// served never diverge on anything that matters.
//
// The injected runtime is OUR trusted code, not user input; injecting it does
// not change the deck's trust model (the deck is sandboxed either way). If an
// author's malformed html neutralizes the injection, the deck simply won't boot
// — the dashboard's hidden-iframe handshake check catches that and warns; it can
// never escape the sandbox.

import { readFile } from "fs/promises";
import path from "path";
import { injectRuntime } from "./inject-runtime";

// Bump BOTH the filename and this constant to ship a runtime v2 (semver the
// runtime; a breaking engine change is a new file, old decks keep working
// against whatever the server injects — which is always current, since we
// re-read the file rather than pin a cached URL).
const RUNTIME_FILE = "vibedeck-v1.js";

let runtimeCache: string | null = null;
let runtimeMissingLogged = false;

// Load the runtime body once per process (cached). Read lazily on first serve so
// a missing file never breaks the build/import — only the serve degrades. Railway
// runs `next start` from the full checkout, so process.cwd()/runtime/... is
// present in production (same pattern the Phase-1 placeholder used for /public).
async function loadRuntime(): Promise<string | null> {
  if (runtimeCache !== null) return runtimeCache;
  try {
    runtimeCache = await readFile(path.join(process.cwd(), "runtime", RUNTIME_FILE), "utf8");
    return runtimeCache;
  } catch (err) {
    if (!runtimeMissingLogged) {
      runtimeMissingLogged = true;
      console.error(`[deck-runtime] could not read runtime/${RUNTIME_FILE}:`, err);
    }
    return null;
  }
}

// The runtime injection (+ the critical </script> escape) lives in the pure,
// client+server-safe lib/inject-runtime so the Studio preview reuses the EXACT
// same logic. See that file for the escape rationale.

/**
 * Transform an uploaded deck's stored html into the exact bytes served to the
 * browser: the author's html with the shared runtime inline-injected. If the
 * runtime file is unreadable, serves the html unchanged (the deck won't boot,
 * but nothing crashes and no partial/broken injection ships). Used by BOTH the
 * /d-content serve route and (implicitly, via the served form) the client
 * boot-check, so there is exactly one serve transform.
 */
export async function renderUploadedDeckHtml(storedHtml: string): Promise<string> {
  const runtime = await loadRuntime();
  if (!runtime) return storedHtml;
  return injectRuntime(storedHtml, runtime);
}

/**
 * The raw runtime JS body (cached), or null if unreadable. Exposed so the Studio
 * live preview can fetch it (via /api/studio/runtime) and inject it into a
 * sandboxed srcdoc iframe with the SAME lib/inject-runtime logic the server uses
 * — preview renders exactly like the real /d-content serve.
 */
export function getRuntimeText(): Promise<string | null> {
  return loadRuntime();
}
