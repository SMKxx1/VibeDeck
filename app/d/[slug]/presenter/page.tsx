import { notFound, redirect } from "next/navigation";
import { cookies } from "next/headers";
import type { Metadata } from "next";
import { getDeck } from "@/lib/decks";
import { PresenterView } from "@/components/PresenterView";
import { PresenterConsole } from "@/components/PresenterConsole";
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
  const deck = getDeck(slug);
  return { title: deck ? `${deck.title} — Presenter` : "Presenter" };
}

export default async function PresenterPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const deck = getDeck(slug);
  if (!deck) notFound();

  // The live deck's presenter view is the dedicated console — presenter-only.
  if (deck.embedUrl) {
    const token = (await cookies()).get(AUTH_COOKIE)?.value;
    if (!verifySessionToken(token)) redirect("/login");
    return <PresenterConsole slug={deck.slug} embedUrl={deck.embedUrl} title={deck.title} />;
  }

  return <PresenterView deck={deck} />;
}
