// Pure, dependency-free, client+server-safe: inline-inject a runtime <script> into
// deck HTML. The server serve-transform (lib/deck-runtime.ts reads
// runtime/vibedeck-v1.js off disk and calls this) produces the exact bytes real
// viewers get from /d-content — one injection + escape, no re-implementation.
//
// CRITICAL ESCAPE: the runtime source contains a literal `</script>` (deck-stage.js's
// own header doc shows `<script src="deck-stage.js"></script>`). Inside an inline
// <script> the HTML parser closes the block at the FIRST `</script`, which would
// truncate the runtime and dump the rest as visible text — the deck then never
// boots. Rewriting `</script` to `<\/script` is identical JS (backslash-slash is
// just a slash in strings/regex, inert in comments) but the HTML parser no longer
// sees a closing tag. Injected before the last </body> so it runs after the deck's
// <deck-stage>/<section>s are parsed.
export function injectRuntime(html: string, runtime: string): string {
  const safe = runtime.replace(/<\/script/gi, "<\\/script");
  const tag = `<script>${safe}</script>`;
  const idx = html.toLowerCase().lastIndexOf("</body>");
  if (idx === -1) return html + tag;
  return html.slice(0, idx) + tag + html.slice(idx);
}
