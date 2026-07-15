import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { getDeck } from "@/lib/decks";
import { AUTH_COOKIE, getSession } from "@/lib/auth";
import { checkDeckManage } from "@/lib/deck-authz";
import { isDbReachable } from "@/lib/db";
import { getDeckSlides } from "@/lib/slides-store";
import { listRecapsForDeck } from "@/lib/study-guide-store";
import { SlideMetaEditor } from "@/components/SlideMetaEditor";
import { DeckWorkbench } from "@/components/DeckWorkbench";

// Presenter-only editor for a deck's per-slide speaker notes + AI grounding.
// Reads the session cookie (per-request), so it must be dynamic.
export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const deck = await getDeck(slug);
  return { title: deck ? `Edit — ${deck.title}` : "Edit deck" };
}

export default async function EditDeckPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  const session = getSession(token);
  if (!session) redirect("/login");

  const { slug } = await params;
  const deck = await getDeck(slug);
  if (!deck) notFound();

  // When the DB is genuinely reachable we get the seeded/edited rows; otherwise
  // the editor still renders (read-only) with a clear "database unavailable"
  // banner. Probe reachability, not just config, so a real outage is visible.
  const dbAvailable = await isDbReachable();

  // Ownership gate (Phase 4): this editor SAVES grounding, and saving is owner-only
  // (the PUT /api/admin/slides route enforces canManageDeck). So refuse to even
  // open the editor for a deck this session can't manage — a presenter aiming at a
  // registry deck or a peer's deck gets a 404, matching the API's non-leak stance,
  // rather than a form whose Save silently 404s. Gate only when the DB is up: with
  // no DB, ownership is unknowable and only registry decks resolve at all (their
  // grounding is presenter-readable per S2), so fall through to the read-only
  // degraded view the banner already covers.
  if (dbAvailable) {
    const perm = await checkDeckManage(session, slug);
    if (!perm.ok) notFound();
  }
  const slides = dbAvailable ? await getDeckSlides(slug) : [];
  // Previously published study-guide handouts for this deck's panel. A read that
  // fails open to [] — with no DB the panel just shows none (and disables Publish).
  const studyGuides = dbAvailable ? await listRecapsForDeck(slug) : [];

  return (
    <SlideMetaEditor
      slug={slug}
      deckTitle={deck.title}
      slides={slides}
      dbAvailable={dbAvailable}
      studyGuides={studyGuides}
      // Preview needs the deck's render info: an embed deck frames embedUrl
      // (first-party), an uploaded deck mints a signed preview URL (contentUrl is
      // defined only when DECK_ORIGIN is set), and a Slide[]-only registry deck has
      // neither → the editor shows a "no preview" placeholder. getDeck already
      // resolves all of these.
      kind={deck.kind}
      contentUrl={deck.contentUrl}
      embedUrl={deck.embedUrl}
      slideCount={deck.slideCount}
      // VDML Workbench: in-app HTML editor + draft preview, ONLY for uploaded
      // decks (registry decks' HTML lives in code) and only when the DB is up
      // (drafts live in decks.draft_html — with no DB there is nothing to edit).
      // The Workbench's owner-only draft API re-enforces authorization on every
      // call; this render gate is UX, the ownership gate above is the security.
      workbench={
        deck.kind === "uploaded" && dbAvailable ? <DeckWorkbench slug={slug} /> : undefined
      }
    />
  );
}
