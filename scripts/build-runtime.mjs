// Assembles runtime/vibedeck-v1.js — the shared platform runtime that
// lib/deck-runtime.ts inline-injects into every served uploaded deck.
//
// The runtime is not authored: it is the SAME <deck-stage> engine and live
// bridge the first-party build-host-website deck loads as separate <script>
// tags, concatenated so uploaded decks get one inlineable body. Keeping it a
// generated artifact means the two paths can never drift — fix the engine once
// in public/decks/build-host-website/ and both the static deck and every
// uploaded deck pick it up.
//
// The output file stays COMMITTED (tests/runtime-generated.test.ts asserts it
// matches this script's output) because deck-runtime.ts reads it off disk at
// serve time, so it must exist in a plain `next start` checkout whether or not
// a build ran. Plain Node, zero deps — it runs before `next build`.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(MODULE_PATH), "..");
const SOURCE_DIR = path.join(REPO_ROOT, "public", "decks", "build-host-website");

// Order matters: deck-stage defines the <deck-stage> custom element the bridge
// then attaches its host-messaging listeners to.
const SOURCES = ["deck-stage.js", "bridge.js"];

const OUTPUT_FILE = path.join(REPO_ROOT, "runtime", "vibedeck-v1.js");

const HEADER =
  "/* VibeDeck platform runtime v1 — <deck-stage> engine + live bridge. " +
  "Inline-injected into served uploaded decks.\n" +
  " * GENERATED from public/decks/build-host-website/{deck-stage,bridge}.js — do not hand-edit; " +
  "rebuild with `npm run build:runtime`. */\n";

/**
 * Build the exact bytes of runtime/vibedeck-v1.js.
 * @returns {Promise<string>} the assembled runtime source
 */
export async function buildRuntimeSource() {
  const parts = await Promise.all(
    SOURCES.map((name) => readFile(path.join(SOURCE_DIR, name), "utf8")),
  );
  return HEADER + parts.join("");
}

async function main() {
  const source = await buildRuntimeSource();
  await writeFile(OUTPUT_FILE, source, "utf8");
  console.log(
    `[build-runtime] wrote runtime/vibedeck-v1.js (${source.length} chars from ${SOURCES.join(" + ")})`,
  );
}

// Only write when invoked as a script, so the test can import the assembler
// without touching the working tree. No top-level await: tests reach this file
// through tsx, which transpiles it to CJS (where top-level await is illegal).
if (process.argv[1] && path.resolve(process.argv[1]) === MODULE_PATH) {
  main().catch((err) => {
    console.error("[build-runtime] failed:", err);
    process.exit(1);
  });
}
