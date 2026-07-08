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
  const decks = listDecks().map((d) => ({
    slug: d.slug,
    title: d.title,
    date: d.date,
    description: d.description ?? "",
    slideCount: d.slideCount ?? d.slides.length,
    publishStatus: statusMap[d.slug] ?? ("normal" as const),
    // Threaded so the publish control can disable "Live" for decks "/" can't
    // render — only self-contained HTML decks (with an embedUrl) go there.
    embedUrl: d.embedUrl,
  }));
  return <DeckLibrary decks={decks} />;
}
