import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getStudyGuide } from "@/lib/study-guide-store";
import { renderMarkdownFragment } from "@/lib/markdown-deck";
import { studyBodyCss } from "./study-css";

// Public study-guide handout page. The unguessable token IS the capability —
// anyone holding the link may read it; a missing/unknown token is a plain 404.
// Served on the APP origin only (never DECK_ORIGIN): the content is presenter-
// authored TRUSTED markdown, but it still renders through the shared escaping
// renderer (lib/markdown-deck.ts) so its text can never become markup. No auth,
// no cookies read — safe to share with anyone.

export const dynamic = "force-dynamic";

// The SCREEN-only half of the handout CSS — the rules the downloadable file
// deliberately renders differently: bigger headings (they sit inside a wider
// card here), underlined links, and the first/last-child margin reset the
// card's own padding needs. Everything shared with the file lives in
// ./study-css, emitted under the same .sg-body scope.
const SCREEN_CSS = `
.sg-body > :first-child { margin-top: 0; }
.sg-body > :last-child { margin-bottom: 0; }
.sg-body h1 { font-size: 26px; font-weight: 600; line-height: 1.2; letter-spacing: -0.01em; margin: 1.4em 0 0.5em; }
.sg-body h2 { font-size: 21px; font-weight: 600; line-height: 1.25; margin: 1.5em 0 0.5em; padding-bottom: 6px; border-bottom: 1px solid rgba(60,55,45,0.12); }
.sg-body a { text-decoration: underline; }
`;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await params;
  const guide = await getStudyGuide(token);
  // Don't leak existence in metadata beyond what the page itself shows.
  return { title: guide ? guide.title || "Study guide" : "Study guide", robots: { index: false } };
}

export default async function StudyGuidePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const guide = await getStudyGuide(token);
  if (!guide) notFound();

  const html = renderMarkdownFragment(guide.markdown);
  const published = new Date(guide.createdAt).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <div
      style={{
        minHeight: "100vh",
        padding: "40px 20px 80px",
        display: "flex",
        justifyContent: "center",
        background: "#ECEAE3",
        backgroundImage: "radial-gradient(rgba(40,38,32,0.045) 1px, transparent 1.4px)",
        backgroundSize: "22px 22px",
      }}
    >
      <div style={{ width: "100%", maxWidth: 760 }}>
        <header
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            gap: 16,
            flexWrap: "wrap",
            marginBottom: 22,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontSize: 12,
                fontWeight: 500,
                letterSpacing: "0.2em",
                textTransform: "uppercase",
                color: "#9A958A",
                marginBottom: 8,
              }}
            >
              Study guide
            </div>
            <h1
              style={{
                fontSize: 30,
                fontWeight: 300,
                lineHeight: 1.15,
                letterSpacing: "-0.02em",
                margin: 0,
                color: "#262229",
              }}
            >
              {guide.title || "Study guide"}
            </h1>
            <p style={{ margin: "8px 0 0", fontSize: 13, color: "#8A857C" }}>
              Published {published}
            </p>
          </div>
          <a
            href={`/study/${guide.token}/download`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              height: 38,
              padding: "0 18px",
              borderRadius: 11,
              background: "#2C2A31",
              color: "#F4F2EC",
              fontSize: 14,
              fontWeight: 500,
              textDecoration: "none",
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            ↓ Download .html
          </a>
        </header>

        <article
          className="sg-body"
          style={{
            padding: "30px 34px 36px",
            borderRadius: 18,
            background: "rgba(255,255,255,0.72)",
            border: "1px solid rgba(255,255,255,0.8)",
            boxShadow: "0 10px 28px -18px rgba(60,55,45,0.4)",
            color: "#2C2A31",
            fontSize: 15.5,
            lineHeight: 1.65,
            overflowWrap: "break-word",
          }}
          // Safe by construction: renderMarkdownFragment HTML-escapes all text
          // (the deck importer's shared renderer) — markdown can't inject markup.
          dangerouslySetInnerHTML={{ __html: html }}
        />

        <p style={{ margin: "20px 0 0", fontSize: 12, color: "#9A958A", textAlign: "center" }}>
          Made with VibeDeck
        </p>
      </div>

      <style>{studyBodyCss(".sg-body") + SCREEN_CSS}</style>
    </div>
  );
}
