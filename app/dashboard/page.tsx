import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { listDecks } from "@/lib/decks";
import { DeckLibrary } from "@/components/DeckLibrary";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/auth";
import { getPublishStatusMap } from "@/lib/publish-store";

// The presenter dashboard (the bento library). Presenter-only: reachable by
// signing in at /login. Viewers land on the live deck at / instead.
export const dynamic = "force-dynamic"; // reads the session cookie

export default async function DashboardPage() {
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  if (!verifySessionToken(token)) redirect("/login");

  // Merge each deck's live publish status. Default 'normal' for any registry deck
  // with no DB row / DB unreachable — matching the backend's fail-open stance and
  // the column default, so a DB hiccup shows every deck as public rather than
  // stranding the presenter with a blank control.
  const statusMap = await getPublishStatusMap();
  const decks = (await listDecks()).map((d) => ({
    slug: d.slug,
    title: d.title,
    date: d.date,
    description: d.description ?? "",
    slideCount: d.slideCount ?? d.slides.length,
    publishStatus: statusMap[d.slug] ?? ("normal" as const),
    // Threaded so the publish control can disable "Live" for decks "/" can't
    // render. "/" has two render paths: an embedUrl (first-party iframe) or, for
    // an uploaded deck, a contentUrl (UploadedDeckFrame) — either makes it Live-able.
    embedUrl: d.embedUrl,
    contentUrl: d.contentUrl,
    // Threaded so uploaded (DB-backed) cards get Replace/Delete/Preview actions
    // while registry (in-code) cards don't — the two are managed differently.
    // Also gates the contentUrl render path above (only 'uploaded' decks use it).
    kind: d.kind ?? ("registry" as const),
  }));
  return <DeckLibrary decks={decks} />;
}
