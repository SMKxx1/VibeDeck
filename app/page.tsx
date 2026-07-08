import { getDeck } from "@/lib/decks";
import { getMainDeckSlug } from "@/lib/publish-store";
import { LiveDeck } from "@/components/LiveDeck";

// The home page shows whichever deck is marked 'main' in the DB. Resolving that
// is a PER-REQUEST read, so this route must be force-dynamic — otherwise Next
// statically bakes it at build time and the DB read would either be frozen or
// throw DYNAMIC_SERVER_USAGE (the same class of problem documented in
// app/d/[slug]/page.tsx). This is a real change from the old static behavior.
export const dynamic = "force-dynamic";

// The env fallback deck — today's exact behavior — used when no deck is marked
// main yet OR the DB is unreachable (getMainDeckSlug returns null for both).
const FALLBACK_SLUG = process.env.NEXT_PUBLIC_LIVE_DECK_SLUG || "build-host-website";

export default async function HomePage() {
  const mainSlug = (await getMainDeckSlug()) ?? FALLBACK_SLUG;
  const deck = getDeck(mainSlug);

  // Neutral 200 empty state — NEVER notFound(). "Nothing is live yet" is not a
  // 404: a 404 signals a broken/removed URL, the wrong signal for a class that
  // simply hasn't started. This also covers the unlikely "main slug points at a
  // registry deck without an embedUrl" case.
  if (!deck || !deck.embedUrl) {
    return (
      <main
        style={{
          minHeight: "100dvh",
          display: "grid",
          placeItems: "center",
          padding: "2rem",
          textAlign: "center",
        }}
      >
        <p style={{ opacity: 0.7, fontSize: "1.1rem" }}>No presentation is live right now.</p>
      </main>
    );
  }

  return <LiveDeck slug={deck.slug} embedUrl={deck.embedUrl} role="viewer" title={deck.title} />;
}
