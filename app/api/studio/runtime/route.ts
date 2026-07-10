import { cookies } from "next/headers";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/auth";
import { getRuntimeText } from "@/lib/deck-runtime";

// Presenter-gated: returns the shared platform runtime JS as text so the Studio's
// live preview can inject it into a sandboxed <iframe srcdoc> (via lib/inject-runtime)
// and render a not-yet-saved deck exactly as /d-content will serve it. The runtime
// is our own non-secret code (it's inline in every public deck already); the gate
// is only so this matches the presenter-only Studio surface. A same-origin fetch
// from /studio carries the cookie automatically.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  if (!verifySessionToken(token)) {
    return new Response("unauthorized", { status: 401 });
  }
  const text = await getRuntimeText();
  if (!text) return new Response("runtime unavailable", { status: 503 });
  return new Response(text, {
    status: 200,
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      // Small and versioned, but the Studio only fetches it once per session — keep
      // it uncacheable so a runtime bump is picked up without stale-cache surprises.
      "Cache-Control": "no-store",
    },
  });
}
