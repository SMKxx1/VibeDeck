// Deck Asset Vault (server-only): per-deck images stored in Postgres
// (deck_assets, migration 009) and served from the isolated DECK_ORIGIN at
// /d-assets/<slug>/<hash>, so an uploaded deck can reference normal same-origin
// <img src> tags instead of inlining data: URIs into its ~2MB html bundle. The
// deck CSP ("img-src 'self' data:") already permits these — an asset served
// from the deck origin is 'self' to the deck — so no CSP change is involved.
//
// EVERY image is decoded and RE-ENCODED here with sharp before storage: EXIF /
// all metadata is stripped (privacy + size), orientation is baked in, and the
// output is always WebP (alpha and animation preserved — WebP carries both).
// Re-encoding also means the stored bytes are pixels we produced, never the
// uploader's raw container bytes.
//
// SIZE POLICY (the owner's decision — implement exactly): NO total-storage or
// per-deck count cap (small trusted user base). The ONLY rule is per stored
// image ≤ 10MB. An input that would exceed that is compressed down to fit with
// MINIMAL quality loss: a quality ladder first (92→85→78→70→60), and only if
// the floor still doesn't fit, a progressive resolution cap (longest side
// 4096→3200→2560→1920) — a genuinely huge image shrinks in resolution rather
// than becoming a blurry mush. Inputs ≤ 10MB get a high-fidelity pass instead
// (lossless WebP for graphics/alpha where it fits, quality-92 WebP otherwise)
// so quality is preserved, never gratuitously degraded.
//
// GUARANTEED FIT: if even 1920px @ q60 doesn't fit (genuinely incompressible
// content — e.g. photographic noise), the ladder does NOT give up: the longest
// side keeps stepping down below 1920 (1600→1280→1024→800→640, then halving,
// floored at 320px purely as a loop guard), retrying the quality ladder —
// extended down to q40 — at each step. WebP bytes fall roughly quadratically
// with dimension, so this always converges. A decodable image is therefore
// ALWAYS stored at ≤ 10MB; UnsupportedImageError is reserved for inputs sharp
// cannot decode (not an image / corrupt), never for "too big".
//
// hash = sha256 of the FINAL stored bytes — content-addressed, so re-uploading
// the same image dedupes onto the existing (slug, hash) row, and the serve
// route can cache immutably (same bytes forever for a given URL).
//
// Conventions match lib/uploaded-decks.ts: reads that feed untrusted-content
// serving fail CLOSED (getAsset → null on miss/DB error), list reads fail OPEN
// ([]), writes THROW so the route can surface a 503. sharp is a native module —
// this file must only ever be imported from server code (route handlers/libs),
// never a client component.

import { createHash } from "node:crypto";
import sharp, { type Metadata } from "sharp";
import { query } from "./db";
import { ensureSchema } from "./schema";

// Bound sharp's libvips thread pool to a single thread process-wide. The
// compression ladder below can run many encode passes on a worst-case
// incompressible image; without a cap sharp would fan those out across every
// core and starve live-presentation traffic on the single Railway instance.
sharp.concurrency(1);

// The one size rule: final stored bytes per image. See the policy note above.
export const MAX_STORED_BYTES = 10 * 1024 * 1024; // 10MB
// Generous RAW upload ceiling so a large original has headroom to compress;
// anything beyond this is rejected outright (route → 413).
export const MAX_RAW_BYTES = 50 * 1024 * 1024; // 50MB

// The compression ladder (see the policy note): quality steps first, then
// progressive longest-side caps retried down the same ladder.
const QUALITY_STEPS = [92, 85, 78, 70, 60];
const DIMENSION_STEPS = [4096, 3200, 2560, 1920];

// GUARANTEED-FIT stage (see the policy note): dimension steps below the
// quality-preserving ladder's 1920px floor, each retried down the quality
// ladder extended to a q40 floor. Past the listed steps the dimension halves
// until MIN_GUARANTEED_DIMENSION — that floor exists only to bound the loop
// (a 320px q40 WebP is a few KB, never anywhere near 10MB), it is never the
// binding constraint for fitting.
const GUARANTEED_QUALITY_STEPS = [...QUALITY_STEPS, 50, 40];
const GUARANTEED_DIMENSION_STEPS = [1600, 1280, 1024, 800, 640];
const MIN_GUARANTEED_DIMENSION = 320;

// The absolute origin that serves deck assets — the SAME env var uploaded-decks
// uses for /d-content, because /d-assets lives on the same isolated deck host.
// Unset → a relative URL (decks reference assets root-relative anyway, which
// resolves against the deck origin inside the frame).
const DECK_ORIGIN = process.env.DECK_ORIGIN;

export function assetUrlFor(slug: string, hash: string): string {
  const path = `/d-assets/${slug}/${hash}`;
  return DECK_ORIGIN ? `${DECK_ORIGIN}${path}` : path;
}

/** Thrown ONLY when the input isn't a decodable image (not an image / corrupt).
 *  Never thrown for size: the guaranteed-fit stage always compresses a
 *  decodable image under the cap. The route maps this to a 4xx, distinct from
 *  DB errors (→ 503). */
export class UnsupportedImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedImageError";
  }
}

export interface StoredAsset {
  hash: string;
  url: string;
  contentType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
}

export interface AssetMeta {
  hash: string;
  url: string;
  contentType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  createdAt: string;
}

// One WebP encode attempt. `animated` keeps GIF/animated-WebP inputs animated
// in the output (sharp decodes all frames when the INPUT was opened with
// { animated: true }). rotate() with no args bakes in the EXIF orientation —
// necessary because we strip metadata (sharp omits EXIF unless .withMetadata()
// is called, which we deliberately never do).
interface EncodeResult {
  data: Buffer;
  width: number;
  height: number;
}

async function encodeWebp(
  input: Buffer,
  animated: boolean,
  opts: { lossless?: boolean; quality?: number; maxDim?: number },
): Promise<EncodeResult> {
  let pipeline = sharp(input, { animated }).rotate();
  if (opts.maxDim) {
    // Cap the LONGEST side; never enlarge a smaller image.
    pipeline = pipeline.resize({
      width: opts.maxDim,
      height: opts.maxDim,
      fit: "inside",
      withoutEnlargement: true,
    });
  }
  const { data, info } = await pipeline
    .webp(
      opts.lossless
        ? { lossless: true, effort: 4 }
        : { quality: opts.quality ?? 92, effort: 4, smartSubsample: true },
    )
    .toBuffer({ resolveWithObject: true });
  // For animated output info.height is the page (frame) height — what a viewer
  // sees — while the raw buffer stacks frames; sharp reports pageHeight on the
  // metadata, but info here is close enough for the picker's display metadata.
  return { data: Buffer.from(data), width: info.width, height: info.height };
}

/**
 * GUARANTEED-FIT stage: keep stepping the longest side down below the main
 * ladder's 1920px floor (1600→1280→1024→800→640, then halving, floored at
 * MIN_GUARANTEED_DIMENSION as a pure loop guard), retrying the extended
 * quality ladder (…→50→40) at every step, and return the FIRST fit — so the
 * result keeps the largest dimension / highest quality that fits. The new low
 * qualities (50/40) are first tried once at full resolution; dimension caps
 * that wouldn't shrink the image are skipped. Returns null only if nothing fit
 * even at the floor — unreachable for a real image (a 320px q40 WebP is a few
 * KB) short of pathological many-frame animations, which the caller handles.
 */
async function encodeSmallestFit(
  input: Buffer,
  animated: boolean,
  longestSide: number,
): Promise<EncodeResult | null> {
  // Finish the quality ladder at full resolution first — q92→60 already
  // failed there, so only the new low floors (50, 40) are worth an attempt.
  for (const quality of GUARANTEED_QUALITY_STEPS) {
    if (QUALITY_STEPS.includes(quality)) continue;
    const attempt = await encodeWebp(input, animated, { quality });
    if (attempt.data.length <= MAX_STORED_BYTES) return attempt;
  }

  let step = 0;
  let maxDim = GUARANTEED_DIMENSION_STEPS[0];
  for (;;) {
    // Skip caps that wouldn't shrink the image (resize would be a no-op —
    // the full-resolution attempts above already covered that case).
    if (!(longestSide > 0 && longestSide <= maxDim)) {
      for (const quality of GUARANTEED_QUALITY_STEPS) {
        const attempt = await encodeWebp(input, animated, { quality, maxDim });
        if (attempt.data.length <= MAX_STORED_BYTES) return attempt;
      }
    }
    if (maxDim <= MIN_GUARANTEED_DIMENSION) return null;
    step += 1;
    maxDim =
      step < GUARANTEED_DIMENSION_STEPS.length
        ? GUARANTEED_DIMENSION_STEPS[step]
        : Math.max(MIN_GUARANTEED_DIMENSION, Math.floor(maxDim / 2));
  }
}

/**
 * Decode, normalize, and compress an uploaded image to the ≤10MB stored form.
 * Implements the exact policy in the file header:
 *   1. Decode with sharp (throws UnsupportedImageError on non-images). All
 *      metadata/EXIF is stripped and orientation baked in on every path.
 *   2. Input ≤ 10MB → HIGH-FIDELITY pass: graphics-like inputs (PNG/GIF/SVG,
 *      or anything with alpha) try LOSSLESS WebP first and keep it when it
 *      fits the cap; photographic inputs (and lossless results that don't fit)
 *      use quality-92 WebP. Alpha and animation survive (WebP carries both).
 *   3. Result (or input) > 10MB → quality ladder 92→85→78→70→60 at full
 *      resolution, stopping at the FIRST fit.
 *   4. Still > 10MB at quality 60 → progressive longest-side caps
 *      4096→3200→2560→1920, each retried down the quality ladder, stopping at
 *      the FIRST fit — resolution gives way before quality collapses further.
 *   5. Still > 10MB at 1920px q60 (genuinely incompressible content) →
 *      GUARANTEED-FIT stage: longest side keeps stepping down below 1920 with
 *      the quality ladder extended to q40 at each step, converging on a fit
 *      (WebP bytes fall ~quadratically with dimension). As an absolute last
 *      resort a pathological many-frame animation is flattened to its first
 *      frame rather than rejected. A decodable image ALWAYS fits; rejection is
 *      only for undecodable input.
 */
async function normalizeImage(input: Buffer): Promise<EncodeResult> {
  let meta: Metadata;
  try {
    meta = await sharp(input, { animated: true }).metadata();
  } catch {
    throw new UnsupportedImageError("not_an_image");
  }
  if (!meta.format) throw new UnsupportedImageError("not_an_image");

  const animated = (meta.pages ?? 1) > 1;
  // "Graphics-like" inputs — screenshots, diagrams, anything with transparency
  // — are where lossy artifacts show worst and lossless compresses best.
  const preferLossless =
    meta.hasAlpha === true || ["png", "gif", "svg"].includes(meta.format);

  try {
    // High-fidelity pass for inputs already within the cap.
    if (input.length <= MAX_STORED_BYTES) {
      if (preferLossless) {
        const lossless = await encodeWebp(input, animated, { lossless: true });
        if (lossless.data.length <= MAX_STORED_BYTES) return lossless;
      }
      const q92 = await encodeWebp(input, animated, { quality: 92 });
      if (q92.data.length <= MAX_STORED_BYTES) return q92;
      // fall through to the ladder below (skip its q92 rung — just done).
    }

    // Quality ladder at full resolution.
    for (const quality of QUALITY_STEPS) {
      const attempt = await encodeWebp(input, animated, { quality });
      if (attempt.data.length <= MAX_STORED_BYTES) return attempt;
    }

    // Resolution steps, each retried down the quality ladder.
    const longest = Math.max(meta.width ?? 0, meta.height ?? 0);
    for (const maxDim of DIMENSION_STEPS) {
      // Skip caps that wouldn't shrink anything (image already smaller).
      if (longest > 0 && longest <= maxDim) continue;
      for (const quality of QUALITY_STEPS) {
        const attempt = await encodeWebp(input, animated, { quality, maxDim });
        if (attempt.data.length <= MAX_STORED_BYTES) return attempt;
      }
    }

    // GUARANTEED-FIT stage: the quality-preserving ladder above is exhausted
    // (incompressible content can exceed the cap even at 1920px q60). Keep
    // shrinking the longest side, retrying the extended quality ladder at
    // each step — this always converges, so no decodable image is rejected
    // for size.
    const fitted = await encodeSmallestFit(input, animated, longest);
    if (fitted) return fitted;
    if (animated) {
      // Absolute last resort: a pathological many-frame animation whose
      // frames can't jointly fit even at the floor — flatten to the first
      // frame (still ≤10MB, still an image) rather than reject.
      const still = await encodeSmallestFit(input, false, longest);
      if (still) return still;
    }
  } catch (err) {
    if (err instanceof UnsupportedImageError) throw err;
    // sharp failed mid-decode/encode — a corrupt or unsupported image.
    throw new UnsupportedImageError("undecodable_image");
  }

  // Unreachable in practice: a single 320px q40 WebP frame is a few KB. Kept
  // as a defensive guard so a sharp regression can never store >10MB bytes.
  throw new UnsupportedImageError("cannot_fit_size_cap");
}

/**
 * Store one image for a deck: normalize/compress per the policy above, then
 * content-address by sha256 of the FINAL bytes. If (slug, hash) already exists
 * the existing row is reused (dedupe) — the INSERT is ON CONFLICT DO NOTHING,
 * safe because identical hash ⇒ identical bytes. WRITE semantics: throws on DB
 * error (route → 503); throws UnsupportedImageError on a non-image (route →
 * 4xx). The caller enforces the MAX_RAW_BYTES ceiling before buffering; we
 * re-check defensively here.
 */
export async function putAsset(slug: string, input: Buffer): Promise<StoredAsset> {
  if (input.length === 0 || input.length > MAX_RAW_BYTES) {
    throw new UnsupportedImageError("raw_too_large");
  }
  const { data, width, height } = await normalizeImage(input);
  const hash = createHash("sha256").update(data).digest("hex");
  const contentType = "image/webp"; // every stored asset is re-encoded WebP

  await ensureSchema();
  await query(
    `INSERT INTO deck_assets (hash, deck_slug, bytes, content_type, byte_size, width, height)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (deck_slug, hash) DO NOTHING`,
    [hash, slug, data, contentType, data.length, width, height],
  );

  return {
    hash,
    url: assetUrlFor(slug, hash),
    contentType,
    byteSize: data.length,
    width,
    height,
  };
}

/**
 * Copy every stored asset from one deck onto another — used when a deck is
 * duplicated so the fork owns its OWN deck_assets rows instead of silently
 * depending on the source deck's. Without this the fork's <img> tags resolve to
 * the source's rows, and deleting the source CASCADE-deletes the shared bytes
 * (migration 009), breaking the fork permanently. A single content-addressed
 * INSERT … SELECT re-homes every row with toSlug substituted for deck_slug;
 * created_at defaults to now, and ON CONFLICT DO NOTHING keeps it idempotent if
 * some (toSlug, hash) rows already exist. WRITE semantics: throws on DB error
 * (the caller — the duplicate route — invokes this best-effort).
 */
export async function copyAssets(fromSlug: string, toSlug: string): Promise<void> {
  await ensureSchema();
  await query(
    `INSERT INTO deck_assets (hash, deck_slug, bytes, content_type, byte_size, width, height)
     SELECT hash, $2, bytes, content_type, byte_size, width, height
     FROM deck_assets WHERE deck_slug = $1
     ON CONFLICT (deck_slug, hash) DO NOTHING`,
    [fromSlug, toSlug],
  );
}

/**
 * The stored bytes for one asset, or null. FAIL CLOSED (null on miss AND on any
 * DB error, indistinguishable) — this feeds the public /d-assets serve route on
 * the deck origin, same contract as getUploadedDeckHtml: never serve, never
 * leak, on a DB error.
 */
export async function getAsset(
  slug: string,
  hash: string,
): Promise<{ bytes: Buffer; contentType: string; byteSize: number } | null> {
  await ensureSchema();
  try {
    const res = await query<{ bytes: Buffer; content_type: string; byte_size: number }>(
      `SELECT bytes, content_type, byte_size FROM deck_assets
       WHERE deck_slug = $1 AND hash = $2`,
      [slug, hash],
    );
    const r = res.rows[0];
    return r ? { bytes: r.bytes, contentType: r.content_type, byteSize: r.byte_size } : null;
  } catch {
    return null; // fail closed
  }
}

/**
 * Metadata (never bytes) for every asset in a deck, newest first — the
 * Workbench picker's list. Fail-OPEN [] on DB error, like the other list reads:
 * the picker just shows nothing, and every real mutation is still gated.
 */
export async function listAssets(slug: string): Promise<AssetMeta[]> {
  await ensureSchema();
  try {
    const res = await query<{
      hash: string;
      content_type: string;
      byte_size: number;
      width: number | null;
      height: number | null;
      created_at: Date | string; // pg hands timestamptz back as a Date
    }>(
      `SELECT hash, content_type, byte_size, width, height, created_at
       FROM deck_assets WHERE deck_slug = $1 ORDER BY created_at DESC`,
      [slug],
    );
    return res.rows.map((r) => ({
      hash: r.hash,
      url: assetUrlFor(slug, r.hash),
      contentType: r.content_type,
      byteSize: r.byte_size,
      width: r.width,
      height: r.height,
      createdAt: String(r.created_at),
    }));
  } catch {
    return [];
  }
}
