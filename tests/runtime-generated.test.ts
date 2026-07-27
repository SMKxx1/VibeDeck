import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildRuntimeSource } from "../scripts/build-runtime.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// runtime/vibedeck-v1.js is a GENERATED concatenation of the deck-stage engine
// and the live bridge, but it is committed (lib/deck-runtime.ts reads it off
// disk at serve time). That combination invites two silent failures: someone
// hand-edits the generated file and the fix vanishes on the next build, or
// someone fixes the engine sources and forgets to regenerate, so uploaded decks
// keep running the stale copy. Byte-comparing the two catches both.
test("committed runtime matches its generator output", async () => {
  const committed = await readFile(path.join(REPO_ROOT, "runtime", "vibedeck-v1.js"), "utf8");
  assert.equal(
    committed,
    await buildRuntimeSource(),
    "runtime/vibedeck-v1.js is stale or hand-edited — run `npm run build:runtime`",
  );
});
