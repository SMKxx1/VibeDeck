import { notFound, redirect } from "next/navigation";
import { cookies } from "next/headers";
import type { Metadata } from "next";
import { getDeck } from "@/lib/decks";
import { PresenterConsole } from "@/components/PresenterConsole";
import { UploadedDeckFrame } from "@/components/UploadedDeckFrame";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/auth";

// Rendered on-demand (never statically baked): this route reads the presenter
// session cookie (a per-request dynamic API) to gate the console — if Next
// statically optimizes it, the cookie read throws DYNAMIC_SERVER_USAGE (a 500)
// in production.
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
  // Gate the WHOLE route: every presenter surface exposes speaker notes and
  // console controls, so an unauthenticated request must never reach one. Check
  // auth BEFORE the deck lookup so existing and missing slugs redirect
  // identically (no 200-vs-404 enumeration oracle) — mirrors
  // app/dashboard/edit/[slug]/page.tsx.
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  if (!verifySessionToken(token)) redirect("/login");

  const { slug } = await params;
  const deck = await getDeck(slug);
  if (!deck) notFound();

  // Uploaded decks are now live-presentable too (#7): this route is fully
  // presenter-gated (redirect above), so render the sandboxed frame in PRESENTER
  // role — the presenter drives it and viewers on /d/<slug> follow. Check before
  // the embedUrl branch below.
  if (deck.kind === "uploaded") return <UploadedDeckFrame deck={deck} role="presenter" />;

  // The live deck's presenter view is the dedicated console.
  if (deck.embedUrl) {
    return <PresenterConsole slug={deck.slug} embedUrl={deck.embedUrl} title={deck.title} />;
  }

  // A registry deck with neither uploaded HTML nor an embedUrl has no renderer —
  // the legacy slides-as-data presenter view was removed with its demo decks.
  notFound();
}
