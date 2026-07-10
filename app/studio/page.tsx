import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/auth";
import { Studio } from "@/components/Studio";

// The presenter-only Studio (Phase 3): an in-browser AI deck-authoring surface
// where a presenter generates decks with their OWN OpenRouter key. Gated exactly
// like /dashboard — cookie → verifySessionToken → /login — because the whole
// surface and the /api/studio proxy it drives are presenter-scoped. force-dynamic
// because we read the session cookie per request (never statically cache the gate).
export const dynamic = "force-dynamic";

export default async function StudioPage() {
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  if (!verifySessionToken(token)) redirect("/login");
  return <Studio />;
}
