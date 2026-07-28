// Deck Asset Vault (server-only): per-deck images stored in Postgres
// (deck_assets, migration 009) and served from the isolated DECK_ORIGIN at
// /d-assets/<slug>/<hash>, so an uploaded deck can reference normal same-origin
// <img src> tags instead of inlining data: URIs into its ~2MB html bundle. The
// deck CSP ("img-src 'self' data:") already permits these — an asset served
// from the deck origin is 'self' to the deck — so no CSP change is involved.
//
// EVERY image is decoded and RE-ENCODED before storage (EXIF stripped,
// orientation baked in, always WebP, compressed to fit a ≤10MB stored cap) by
// lib/image-normalize.ts — the whole sharp pipeline and its size policy live
// there; this module only stores and serves what it returns.
//
// hash = sha256 of the FINAL stored bytes — content-addressed, so re-uploading
// the same image dedupes onto the existing (slug, hash) row, and the serve
// route can cache immutably (same bytes forever for a given URL).
//
// Conventions match lib/uploaded-decks.ts: reads that feed untrusted-content
// serving fail CLOSED (getAsset → null on miss/DB error), list reads fail OPEN
// ([]), writes THROW so the route can surface a 503. image-normalize pulls in
// sharp, a native module — this file must only ever be imported from server
// code (route handlers/libs), never a client component.

import { createHash } from "node:crypto";
import { query } from "./db";
import { ensureSchema } from "./schema";
import {
  normalizeImage,
  MAX_RAW_BYTES,
  MAX_STORED_BYTES,
  UnsupportedImageError,
} from "./image-normalize";

// Re-exported so the vault's public surface is unchanged by the split: callers
// (the assets route) keep importing the size policy and the error class from
// lib/deck-assets, next to the putAsset that enforces them.
export { MAX_RAW_BYTES, MAX_STORED_BYTES, UnsupportedImageError };

// The absolute origin that serves deck assets — the SAME env var uploaded-decks
// uses for /d-content, because /d-assets lives on the same isolated deck host.
// Unset → a relative URL (decks reference assets root-relative anyway, which
// resolves against the deck origin inside the frame).
const DECK_ORIGIN = process.env.DECK_ORIGIN;

export function assetUrlFor(slug: string, hash: string): string {
  const path = `/d-assets/${slug}/${hash}`;
  return DECK_ORIGIN ? `${DECK_ORIGIN}${path}` : path;
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

/**
 * Store one image for a deck: normalize/compress per the policy in
 * lib/image-normalize.ts, then
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
