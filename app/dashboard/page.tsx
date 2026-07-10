import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { listDecks } from "@/lib/decks";
import { DeckLibrary } from "@/components/DeckLibrary";
import { AUTH_COOKIE, getSession, canManageDeck } from "@/lib/auth";
import { getPublishStatusMap } from "@/lib/publish-store";
import { getAllDeckOwners } from "@/lib/uploaded-decks";

// The presenter dashboard (the bento library). Reachable by signing in at /login.
// Viewers land on the live deck at / instead.
export const dynamic = "force-dynamic"; // reads the session cookie

export default async function DashboardPage() {
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  // getSession (not the boolean gate) because Phase 4 scopes the dashboard by
  // identity: an admin sees/manages everything; a presenter sees registry decks
  // (to present) plus only the uploaded decks they own (to manage).
  const session = getSession(token);
  if (!session) redirect("/login");
  const isAdmin = session.role === "admin";

  // Merge each deck's live publish status. Default 'normal' for any registry deck
  // with no DB row / DB unreachable — matching the backend's fail-open stance and
  // the column default, so a DB hiccup shows every deck as public rather than
  // stranding the presenter with a blank control.
  const statusMap = await getPublishStatusMap();
  // One query for every deck's owner so we can compute manage rights without N
  // round-trips. {} on DB error → nothing reads as manageable (safe: the routes
  // still enforce authz on every real write).
  const owners = await getAllDeckOwners();

  const all = (await listDecks()).map((d) => {
    const ownerId = owners[d.slug] ?? null;
    return {
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
      // Phase 4: may THIS session manage this deck (edit notes, replace, delete,
      // toggle Public/Hidden)? Admin → always; presenter → only a deck they own.
      // The UI hides owner-only affordances where this is false; the server is the
      // real boundary (every mutation re-checks canManageDeck).
      canManage: canManageDeck(session, ownerId),
    };
  });

  // Presenters only receive registry decks (shared — presentable, not manageable)
  // plus decks they can manage; another presenter's uploaded decks are withheld
  // entirely, so an unpublished draft never leaks into a peer's library. Admins
  // get the full set. This mirrors the server authz — it just spares a presenter a
  // grid of controls that would 404/403.
  const decks = isAdmin ? all : all.filter((d) => d.kind === "registry" || d.canManage);

  return <DeckLibrary decks={decks} isAdmin={isAdmin} />;
}
