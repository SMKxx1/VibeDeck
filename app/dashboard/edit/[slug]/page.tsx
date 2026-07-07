import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { getDeck } from "@/lib/decks";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/auth";
import { isDbReachable } from "@/lib/db";
import { getDeckSlides } from "@/lib/slides-store";
import { SlideMetaEditor } from "@/components/SlideMetaEditor";

// Presenter-only editor for a deck's per-slide speaker notes + AI grounding.
// Reads the session cookie (per-request), so it must be dynamic.
export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const deck = getDeck(slug);
  return { title: deck ? `Edit — ${deck.title}` : "Edit deck" };
}

export default async function EditDeckPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  if (!verifySessionToken(token)) redirect("/login");

  const { slug } = await params;
  const deck = getDeck(slug);
  if (!deck) notFound();

  // When the DB is genuinely reachable we get the seeded/edited rows; otherwise
  // the editor still renders (read-only) with a clear "database unavailable"
  // banner. Probe reachability, not just config, so a real outage is visible.
  const dbAvailable = await isDbReachable();
  const slides = dbAvailable ? await getDeckSlides(slug) : [];

  return (
    <SlideMetaEditor
      slug={slug}
      deckTitle={deck.title}
      slides={slides}
      dbAvailable={dbAvailable}
    />
  );
}
