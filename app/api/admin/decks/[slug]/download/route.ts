import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, getSession } from "@/lib/auth";
import { checkDeckManage } from "@/lib/deck-authz";
import { getUploadedDeckHtml } from "@/lib/uploaded-decks";
import { renderUploadedDeckHtml } from "@/lib/deck-runtime";

// Owner-gated DOWNLOAD (GET) — hand back a fully self-contained, offline-capable
// copy of an uploaded deck for low-bandwidth / offline use. This DELIBERATELY
// bypasses the publish gate that /d-content enforces (it serves an 'unpublished'
// deck's bytes too), so it MUST NOT be public: gate with an authenticated session
// (401) + OWNERSHIP (checkDeckManage → 404 on !ok, admin or the deck's owner
// only; indistinguishable from a missing slug). No CSRF check: this is a read-only
// GET navigation, not a state change — assertSameOrigin guards WRITES, and a file
// download triggered by window.location can't send custom headers anyway.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function currentSession() {
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  return getSession(token);
}

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const session = await currentSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { slug } = await params;

  // Ownership before we read any bytes: a non-owner (or a registry/missing slug)
  // gets a flat 404 and learns nothing about the deck.
  const perm = await checkDeckManage(session, slug);
  if (!perm.ok) {
    return NextResponse.json({ error: perm.error }, { status: perm.status });
  }

  // Only uploaded decks have stored html — a registry/missing slug (or a DB blip)
  // is null → 404, same fail-closed contract as /d-content.
  const row = await getUploadedDeckHtml(slug);
  if (!row) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Serve the SAME serve-time transform /d-content uses (lib/deck-runtime), so the
  // downloaded file is a complete deck with the platform runtime inlined — it opens
  // and presents straight off disk, with no network and no separate runtime.
  const renderedHtml = await renderUploadedDeckHtml(row.html);

  return new NextResponse(renderedHtml, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": `attachment; filename="${slug}.html"`,
      "Cache-Control": "no-store",
    },
  });
}
