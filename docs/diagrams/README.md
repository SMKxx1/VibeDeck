# Architecture diagrams

The main README embeds **Mermaid** versions of these diagrams (rendered natively
by GitHub). The SVGs here are the high-fidelity Figma exports of the same four
views, authored in FigJam — the Figma board is their source of truth:
https://www.figma.com/board/zJNwrFsZEoK1gQK9TyOvtz

Rule: **edit in Figma, re-export, commit — never edit the exports.** Each frame
is exported as an SVG named after the file it lands in:

| File | Answers |
|---|---|
| `system-overview.svg` | What are the moving parts, and which origin is which? |
| `live-room-flow.svg` | During a live session, who talks to whom, how often? |
| `deck-lifecycle.svg` | How does untrusted HTML become a safely served live deck? |
| `auth-flows.svg` | How do the two sign-in paths work, and where does Telegram fit? |
