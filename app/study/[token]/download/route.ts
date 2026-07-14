import { NextResponse } from "next/server";
import { getRecap, type StudyGuide } from "@/lib/study-guide-store";
import { renderMarkdownFragment } from "@/lib/markdown-deck";

// Offline handout download: the same token-gated guide as /study/<token>, but
// packaged as ONE self-contained .html file — inline CSS, zero external
// requests, zero scripts — so it opens from a laptop's Downloads folder with no
// network at all. Same trust posture as the page: presenter-authored markdown
// rendered through the shared escaping renderer, served only on the APP origin
// (the deck-host middleware allowlist 404s this path there by construction).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ASCII-safe attachment filename derived from the title (header values must not
// carry arbitrary bytes). Falls back to a generic name.
function filenameFor(guide: StudyGuide): string {
  const base = (guide.title || "study-guide")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${base || "study-guide"}.html`;
}

function standaloneHtml(guide: StudyGuide): string {
  const title = escapeHtml(guide.title || "Study guide");
  const published = new Date(guide.createdAt).toISOString().slice(0, 10);
  const body = renderMarkdownFragment(guide.markdown);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { margin: 0; padding: 40px 20px 80px; background: #ECEAE3; color: #2C2A31;
         font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
         font-size: 15.5px; line-height: 1.65; }
  main { max-width: 720px; margin: 0 auto; background: #FFFFFF; border-radius: 16px;
         padding: 34px 38px 40px; box-shadow: 0 10px 28px -18px rgba(60,55,45,0.4);
         overflow-wrap: break-word; }
  .sg-meta { font-size: 12px; letter-spacing: 0.18em; text-transform: uppercase;
             color: #9A958A; margin: 0 0 6px; }
  .sg-title { font-size: 28px; font-weight: 600; line-height: 1.2; margin: 0 0 4px; }
  .sg-date { font-size: 13px; color: #8A857C; margin: 0 0 26px; }
  main h1 { font-size: 24px; font-weight: 600; line-height: 1.2; margin: 1.4em 0 0.5em; }
  main h2 { font-size: 20px; font-weight: 600; line-height: 1.25; margin: 1.5em 0 0.5em;
            padding-bottom: 6px; border-bottom: 1px solid rgba(60,55,45,0.12); }
  main h3 { font-size: 17px; font-weight: 600; margin: 1.3em 0 0.4em; }
  main h4, main h5, main h6 { font-size: 15.5px; font-weight: 600; margin: 1.2em 0 0.4em; }
  main p { margin: 0 0 0.85em; }
  main ul, main ol { margin: 0.2em 0 0.9em; padding-left: 1.4em; }
  main li { margin: 0.3em 0; }
  main strong { font-weight: 650; }
  main a { color: #55701C; }
  main code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.88em;
              background: rgba(60,55,45,0.07); padding: 0.12em 0.4em; border-radius: 5px; }
  main pre { background: #26241F; color: #EDEAE1; border-radius: 12px; padding: 16px 20px;
             overflow-x: auto; font-size: 13.5px; line-height: 1.55; margin: 0.4em 0 1em; }
  main pre code { background: none; color: inherit; padding: 0; }
  main blockquote { margin: 0.4em 0 0.9em; padding: 2px 0 2px 16px;
                    border-left: 3px solid rgba(140,170,40,0.85); color: #57534A; font-style: italic; }
  footer { max-width: 720px; margin: 18px auto 0; text-align: center;
           font-size: 12px; color: #9A958A; }
  @media print { body { background: #fff; padding: 0; } main { box-shadow: none; padding: 0; } }
</style>
</head>
<body>
<main>
<p class="sg-meta">Study guide</p>
<p class="sg-title">${title}</p>
<p class="sg-date">Published ${published}</p>
${body}
</main>
<footer>Made with VibeDeck</footer>
</body>
</html>
`;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const guide = await getRecap(token);
  if (!guide) return new NextResponse(null, { status: 404 });
  return new NextResponse(standaloneHtml(guide), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filenameFor(guide)}"`,
      "Cache-Control": "no-store",
    },
  });
}
