// Small, runtime-safe configuration validators shared by Node route handlers and
// Edge middleware. Keep this module free of Node-only APIs: middleware imports it.

export const MIN_AUTH_SECRET_BYTES = 32;

const AUTH_SECRET_PLACEHOLDER_MARKERS = [
  "changeme",
  "replaceme",
  "placeholder",
  "devinsecure",
  "exampleonly",
  "yourauthsecret",
  "yourlongrandomsecret",
];

function isShortRepeatedPattern(value: string): boolean {
  for (let width = 1; width <= 8 && width < value.length; width += 1) {
    if (value.length % width === 0 && value.slice(0, width).repeat(value.length / width) === value) {
      return true;
    }
  }
  return false;
}

/**
 * Return a safe-to-log production AUTH_SECRET configuration error, or null.
 * This cannot prove entropy, but it rejects the deployment mistakes that turn a
 * signed admin cookie into a forgeable credential: missing/short values, the
 * checked-in examples, whitespace mistakes, and trivial repeated strings.
 */
export function authSecretConfigError(
  value: string | undefined = process.env.AUTH_SECRET,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): string | null {
  if (nodeEnv !== "production") return null;
  if (!value) return "AUTH_SECRET must be set in production";
  if (value !== value.trim()) return "AUTH_SECRET must not contain leading or trailing whitespace";
  if (new TextEncoder().encode(value).byteLength < MIN_AUTH_SECRET_BYTES) {
    return `AUTH_SECRET must contain at least ${MIN_AUTH_SECRET_BYTES} bytes in production`;
  }

  const compact = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (AUTH_SECRET_PLACEHOLDER_MARKERS.some((marker) => compact.includes(marker))) {
    return "AUTH_SECRET is still set to a placeholder value";
  }
  if (new Set(value).size < 8 || isShortRepeatedPattern(value)) {
    return "AUTH_SECRET is too predictable; generate a cryptographically random value";
  }
  return null;
}
