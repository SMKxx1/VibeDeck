// Image normalization for the Deck Asset Vault (server-only): the sharp/WebP
// encode pipeline that turns an uploaded image into the exact bytes
// lib/deck-assets.ts stores. Pure image work — no DB, no deck model, no
// knowledge of where the result ends up.
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
// sharp is a native module — this file must only ever be imported from server
// code (route handlers/libs), never a client component.

import sharp, { type Metadata } from "sharp";

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

// One WebP encode attempt. `animated` keeps GIF/animated-WebP inputs animated
// in the output (sharp decodes all frames when the INPUT was opened with
// { animated: true }). rotate() with no args bakes in the EXIF orientation —
// necessary because we strip metadata (sharp omits EXIF unless .withMetadata()
// is called, which we deliberately never do).
export interface EncodeResult {
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
export async function normalizeImage(input: Buffer): Promise<EncodeResult> {
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
