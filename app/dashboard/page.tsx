import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { listDecks } from "@/lib/decks";
import { DeckLibrary } from "@/components/DeckLibrary";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/auth";

// The presenter dashboard (the bento library). Presenter-only: reachable by
// signing in at /login. Viewers land on the live deck at / instead.
export const dynamic = "force-dynamic"; // reads the session cookie

export default async function DashboardPage() {
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  if (!verifySessionToken(token)) redirect("/login");

  const decks = listDecks().map((d) => ({
    slug: d.slug,
    title: d.title,
    date: d.date,
    description: d.description ?? "",
    slideCount: d.slideCount ?? d.slides.length,
  }));
  return <DeckLibrary decks={decks} />;
}
