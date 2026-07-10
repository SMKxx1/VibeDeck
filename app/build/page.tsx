import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { readFile } from "fs/promises";
import path from "path";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/auth";
import { BuildGuide } from "@/components/BuildGuide";

// The "Build a deck with AI" page. Presenter-only, gated identically to the
// dashboard (read the session cookie, verify it, else /login). It hands the
// presenter the exact copy-paste prompt that makes an AI emit a deck conforming
// to the VibeDeck bundle contract, plus a self-check checklist that mirrors the
// server-side validator (lib/deck-validator.ts) so a deck can be eyeballed
// before it's uploaded.
export const dynamic = "force-dynamic"; // reads the session cookie

// The canonical prompt lives in VIBEDECK_PROMPT.md at the repo root — one source
// of truth for the copy block here. Read it at request time from process.cwd():
// Railway runs `next start` from the full checkout, so the file is present in
// production. This is the SAME file-read pattern lib/deck-runtime.ts uses to load
// runtime/vibedeck-v1.js, so there's no new file-tracing assumption to justify.
async function loadPrompt(): Promise<string> {
  try {
    return await readFile(path.join(process.cwd(), "VIBEDECK_PROMPT.md"), "utf8");
  } catch (err) {
    // Degrade rather than crash: the checklist stands on its own, and the copy
    // block points the presenter at the canonical file in the repo.
    console.error("[build] could not read VIBEDECK_PROMPT.md:", err);
    return "The deck-authoring prompt could not be loaded. See VIBEDECK_PROMPT.md in the VibeDeck repository.";
  }
}

export default async function BuildPage() {
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  if (!verifySessionToken(token)) redirect("/login");
  const prompt = await loadPrompt();
  return <BuildGuide prompt={prompt} />;
}
