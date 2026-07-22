import assert from "node:assert/strict";
import test from "node:test";
import { authSecretConfigError } from "../lib/config";
import { validateDeckHtml } from "../lib/deck-validator";
import { isValidDeckSlug, safeHttpsUrl } from "../lib/request-security";
import { sanitizeBranches } from "../lib/types";

test("production auth secrets reject missing, short, and placeholder values", () => {
  assert.match(authSecretConfigError(undefined, "production") ?? "", /must be set/);
  assert.match(authSecretConfigError("short", "production") ?? "", /at least 32 bytes/);
  assert.match(
    authSecretConfigError("change-me-to-a-long-random-string-please", "production") ?? "",
    /placeholder/,
  );
  assert.equal(
    authSecretConfigError("f9aE!2xQ7#Lm4$pR8^vN1&cK6*Sz3@wT0+Hd5", "production"),
    null,
  );
});

test("deck slug grammar is strict and bounded", () => {
  assert.equal(isValidDeckSlug("lesson-01"), true);
  assert.equal(isValidDeckSlug("a"), true);
  assert.equal(isValidDeckSlug("Uppercase"), false);
  assert.equal(isValidDeckSlug("../secret"), false);
  assert.equal(isValidDeckSlug("a".repeat(65)), false);
  assert.equal(isValidDeckSlug("-bad"), false);
});

test("external links accept only credential-free HTTPS URLs", () => {
  assert.equal(safeHttpsUrl("https://example.com/path?q=1"), "https://example.com/path?q=1");
  assert.equal(safeHttpsUrl("http://example.com"), null);
  assert.equal(safeHttpsUrl("javascript:alert(1)"), null);
  assert.equal(safeHttpsUrl("https://user:pass@example.com"), null);
  assert.equal(safeHttpsUrl(`https://example.com/${"x".repeat(2048)}`), null);
});

test("deck validation derives an authoritative slide count", () => {
  const valid = validateDeckHtml(`
    <!doctype html><html><body><deck-stage>
      <section data-label="One"></section>
      <section data-label="Two"></section>
    </deck-stage></body></html>
  `);
  assert.equal(valid.ok, true);
  assert.equal(valid.slideCount, 2);
  assert.deepEqual(valid.slides.map((slide) => slide.index), [0, 1]);

  const externalScript = validateDeckHtml(
    `<deck-stage><section></section></deck-stage><script src="https://example.com/x.js"></script>`,
  );
  assert.equal(externalScript.ok, false);
  assert.match(externalScript.issues.join(" "), /External <script src>/);
});

test("branch validation removes destinations outside a shrunken deck", () => {
  assert.deepEqual(
    sanitizeBranches(
      [
        { label: "Keep", from: 1, to: 2 },
        { label: "Drop", from: 3, to: 5 },
      ],
      4,
    ),
    null,
  );
  assert.deepEqual(
    sanitizeBranches(
      [
        { label: "A", from: 1, to: 2 },
        { label: "B", from: 2, to: 3 },
      ],
      4,
    ),
    [
      { label: "A", from: 1, to: 2 },
      { label: "B", from: 2, to: 3 },
    ],
  );
});
