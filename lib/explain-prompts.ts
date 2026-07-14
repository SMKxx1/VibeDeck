// "Explain differently" reframe instructions (#10) — fixed prompts, one per mode.
// Shared by /api/ask (the viewer chips) and /api/recap (the presenter's one-tap
// room recap) so both features generate INTERCHANGEABLE answers and can share a
// single room cache entry per (slug, slideIndex, mode) — see getExplainCache in
// lib/kv.ts. Keep the texts stable: changing one silently invalidates nothing
// (the cache is keyed by mode, not prompt), it just shifts future answers.

export const EXPLAIN_PROMPTS = {
  eli5: "Explain what this slide is teaching as simply as you possibly can — as if to a curious beginner with no background. Use plain words and, if it helps, one everyday example.",
  analogy: "Explain the core idea on this slide using a single concrete, everyday analogy that makes it click.",
  example: "Walk through one short, concrete worked example that illustrates what this slide is teaching.",
  deeper: "Go one level deeper on this slide — the reasoning behind it, an important nuance, or how it connects to the bigger picture — while staying accurate to the material shown.",
} as const;

export type ExplainMode = keyof typeof EXPLAIN_PROMPTS;

export function isExplainMode(m: string): m is ExplainMode {
  return m in EXPLAIN_PROMPTS;
}
