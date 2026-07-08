import { notFound, redirect } from "next/navigation";
import { cookies } from "next/headers";
import type { Metadata } from "next";
import { getDeck } from "@/lib/decks";
import { PresenterView } from "@/components/PresenterView";
import { PresenterConsole } from "@/components/PresenterConsole";
import { UploadedDeckFrame } from "@/components/UploadedDeckFrame";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/auth";

// Rendered on-demand (never statically baked): the live (embed) deck reads the
// presenter session cookie (a per-request dynamic API) to gate the console.
// Shared with the hand-authored decks, so the whole route must be dynamic —
// otherwise Next statically optimizes it and the cookie read throws
// DYNAMIC_SERVER_USAGE (a 500) in production.
export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  const presenter = verifySessionToken(token);

  // The presenter console is presenter-only content — always keep it out of
  // search indexes. And never leak the real deck title to a non-presenter: this
  // route hides both published and unpublished decks behind auth, so a generic
  // "Presenter" title for anyone unauthenticated avoids confirming the slug
  // exists (the same slug-enumeration oracle the sibling /d/[slug] fix closes).
  if (!presenter) {
    return { title: "Presenter", robots: { index: false, follow: false } };
  }
  const deck = await getDeck(slug);
  return {
    title: deck ? `${deck.title} — Presenter` : "Presenter",
    robots: { index: false, follow: false },
  };
}

export default async function PresenterPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  // Gate the WHOLE route, not just the embed branch: the hand-authored decks
  // (the only ones that can realistically be "unpublished") render via
  // PresenterView below, which exposes full slide bodies AND speaker notes. An
  // unauthenticated request must never reach that. Check auth BEFORE the deck
  // lookup so existing and missing slugs redirect identically (no 200-vs-404
  // enumeration oracle) — mirrors app/dashboard/edit/[slug]/page.tsx.
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  if (!verifySessionToken(token)) redirect("/login");

  const { slug } = await params;
  const deck = await getDeck(slug);
  if (!deck) notFound();

  // Uploaded decks have no live-presenter sync in Phase 1 — they're self-contained
  // artifacts, so the presenter route just renders the same sandboxed frame (no
  // notes/next-slide console). Check before the embedUrl branch below.
  if (deck.kind === "uploaded") return <UploadedDeckFrame deck={deck} />;

  // The live deck's presenter view is the dedicated console.
  if (deck.embedUrl) {
    return <PresenterConsole slug={deck.slug} embedUrl={deck.embedUrl} title={deck.title} />;
  }

  return <PresenterView deck={deck} />;
}
