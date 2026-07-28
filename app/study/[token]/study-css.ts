// The study-guide handout's shared prose CSS. Two targets render the SAME
// markdown fragment (renderMarkdownFragment) and used to hand-maintain two
// copies of these rules: the on-screen page (./page.tsx, scoped to .sg-body)
// and the standalone downloadable .html file (./download/route.ts, scoped to
// main). Only the rules that were VERBATIM IDENTICAL in both live here.
//
// The intentional screen-vs-file differences stay as a small override string
// next to each consumer: the page uses bigger headings inside its card,
// underlines links, and resets the first/last child's margin; the file uses
// slightly smaller headings plus its own standalone chrome (body, card, header
// lines, footer) and print rules.
//
// Every rule is emitted under the caller's scope selector, so each target keeps
// exactly the specificity and cascade it had before the extraction.

export function studyBodyCss(scope: string): string {
  return `
${scope} h3 { font-size: 17px; font-weight: 600; margin: 1.3em 0 0.4em; }
${scope} h4, ${scope} h5, ${scope} h6 { font-size: 15.5px; font-weight: 600; margin: 1.2em 0 0.4em; }
${scope} p { margin: 0 0 0.85em; }
${scope} ul, ${scope} ol { margin: 0.2em 0 0.9em; padding-left: 1.4em; }
${scope} li { margin: 0.3em 0; }
${scope} strong { font-weight: 650; }
${scope} a { color: #55701C; }
${scope} code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.88em; background: rgba(60,55,45,0.07); padding: 0.12em 0.4em; border-radius: 5px; }
${scope} pre { background: #26241F; color: #EDEAE1; border-radius: 12px; padding: 16px 20px; overflow-x: auto; font-size: 13.5px; line-height: 1.55; margin: 0.4em 0 1em; }
${scope} pre code { background: none; color: inherit; padding: 0; }
${scope} blockquote { margin: 0.4em 0 0.9em; padding: 2px 0 2px 16px; border-left: 3px solid rgba(140,170,40,0.85); color: #57534A; font-style: italic; }
`;
}
