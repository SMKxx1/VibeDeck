import assert from "node:assert/strict";
import test from "node:test";
import { slugifyTitle } from "../lib/deck-create";
import { staticDecks } from "../lib/decks/static";

// The live bridge gates the pinboard on `e.origin === location.origin` (see
// public/deck-engine/bridge.js), which holds only because LiveDeck frames a
// registry deck from a RELATIVE path — parent and deck therefore share the app's
// origin. An absolute cross-origin embedUrl would leave the deck working but the
// pin wall silently empty, with nothing in the console to explain it. Asserting
// the invariant here makes that a red test instead of a field report. (The public
// build ships no bundled decks, so this passes vacuously there.)
test("registry embedUrls stay same-origin, which the pinboard gate depends on", () => {
  for (const deck of staticDecks) {
    if (!deck.embedUrl) continue;
    assert.ok(
      deck.embedUrl.startsWith("/") && !deck.embedUrl.startsWith("//"),
      `${deck.slug}: embedUrl must be a relative same-origin path, got ${deck.embedUrl}`,
    );
  }
});

test("slugifyTitle honours its documented contract", () => {
  assert.equal(slugifyTitle("Build & Host Your Own Website"), "build-host-your-own-website");
  assert.equal(slugifyTitle("MiXeD CaSe"), "mixed-case");
  assert.equal(slugifyTitle("  leading and trailing  "), "leading-and-trailing");
  assert.equal(slugifyTitle("--dashes--everywhere--"), "dashes-everywhere");
  assert.equal(slugifyTitle("café"), "caf");
  assert.equal(slugifyTitle("🎉 party 🎉"), "party");
  // An all-symbol title yields "" — callers supply their own `|| "deck"` fallback.
  assert.equal(slugifyTitle("!!!"), "");
  assert.equal(slugifyTitle(""), "");
  // Capped at 60, and the cut must never leave a trailing hyphen behind. When the
  // 60-char cut lands exactly ON the separator the trailing trim takes it, so this
  // one comes back 59 — that second trim after the slice is why.
  assert.equal(slugifyTitle("a".repeat(59) + " b"), "a".repeat(59));
  assert.equal(slugifyTitle("a".repeat(60) + " b"), "a".repeat(60));
  assert.doesNotMatch(slugifyTitle("a".repeat(59) + " b"), /-$/);
});

// THE LOAD-BEARING INVARIANT. slugifyTitle trims with `/^-/` and `/-$/` — a single
// hyphen, not `-+` — and that is only correct because the preceding collapse of
// every maximal non-alphanumeric run to ONE hyphen makes two adjacent hyphens
// impossible. Reorder or drop that collapse and the trims silently stop trimming.
// This pins the invariant directly rather than trusting the comment.
test("slugify collapse never leaves two adjacent hyphens for the trims to miss", () => {
  const titles = [
    "-".repeat(200),
    "x" + "-".repeat(200) + "y",
    "a___b...c///d",
    "\t\n mixed \t whitespace \n",
    "İstanbul",
    "😀".repeat(40),
    "a" + "!@#$%^&*()".repeat(20) + "b",
  ];
  for (const title of titles) {
    const slug = slugifyTitle(title);
    assert.doesNotMatch(slug, /--/, `doubled hyphen in slug for ${JSON.stringify(title)}`);
    assert.doesNotMatch(slug, /^-|-$/, `untrimmed hyphen in slug for ${JSON.stringify(title)}`);
  }
});

// CodeQL js/polynomial-redos flagged the old `/^-+|-+$/g` trim. The collapse above
// already kept a hyphen run from ever reaching it, so this asserts the property
// that actually matters and would break first: slugifying stays linear. The old
// regex shape on an uncollapsed run of this size takes seconds; the bound is loose
// enough (~1000x the measured cost) that it can only fail if the collapse is
// removed and the quadratic backtracking is re-armed.
test("slugifyTitle stays linear on a pathological run of separators", () => {
  const started = process.hrtime.bigint();
  const slug = slugifyTitle("a" + "-".repeat(2_000_000) + "b");
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(slug, "a-b");
  assert.ok(elapsedMs < 1000, `slugifyTitle took ${elapsedMs.toFixed(1)}ms — backtracking is back`);
});
