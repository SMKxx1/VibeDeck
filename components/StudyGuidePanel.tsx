"use client";

// AI Study-Guide Handout panel — lives on the deck edit page (SlideMetaEditor's
// main column), styled to the same warm "Solis" glass-card language.
//
// Flow (review-before-publish, the same hard rule as AI grounding #8):
//   1. "Draft with AI" → POST /api/study-guide {action:'draft'} — the server
//      gathers the deck material + notes + revealed poll + Q&A themes and
//      returns Markdown. NOTHING is persisted.
//   2. The presenter edits the title + markdown right here.
//   3. "Publish" → POST {action:'publish', title, markdown} → an unguessable
//      /study/<token> link (shown with Copy/Open + a growing "published" list).
// The share link is rebuilt from location.origin client-side so it's always the
// origin the presenter is actually on.

import { useState } from "react";

export interface PublishedGuide {
  token: string;
  title: string;
  createdAt: number;
}

const MAX_TITLE = 160;
const MAX_MARKDOWN = 60_000;

type DraftStatus = "idle" | "drafting" | "error";
type PublishStatus = "idle" | "publishing" | "published" | "error";

function draftMessageFor(status: number, error?: string): string {
  if (error === "ai_budget_exceeded") return "AI is at today's usage limit — try again later.";
  if (error === "rate_limited") return "Too many requests — wait a moment and retry.";
  if (error === "ai_not_configured") return "AI isn't configured on the server.";
  if (error === "no_content")
    return "This deck has no AI context or speaker notes yet — add some (or Generate all empty) first.";
  if (status === 401 || status === 403) return "Session expired or blocked — sign in again.";
  return "Couldn't draft — try again.";
}

function publishMessageFor(status: number, error?: string): string {
  if (error === "empty_markdown") return "Nothing to publish — the guide is empty.";
  if (error === "too_long")
    return `Too long — keep the guide under ${MAX_MARKDOWN.toLocaleString()} characters.`;
  if (status === 503) return "Database unavailable — try again later.";
  if (status === 404) return "You can't publish for this deck.";
  if (status === 401 || status === 403) return "Session expired or blocked — sign in again.";
  return "Couldn't publish — try again.";
}

export function StudyGuidePanel({
  slug,
  deckTitle,
  dbAvailable,
  guides,
}: {
  slug: string;
  deckTitle: string;
  dbAvailable: boolean;
  guides: PublishedGuide[];
}) {
  const [title, setTitle] = useState(`${deckTitle} — Study guide`.slice(0, MAX_TITLE));
  const [markdown, setMarkdown] = useState("");
  const [draftStatus, setDraftStatus] = useState<DraftStatus>("idle");
  const [draftError, setDraftError] = useState<string | null>(null);
  const [publishStatus, setPublishStatus] = useState<PublishStatus>("idle");
  const [publishError, setPublishError] = useState<string | null>(null);
  const [published, setPublished] = useState<PublishedGuide[]>(guides);
  const [lastToken, setLastToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const drafting = draftStatus === "drafting";
  const publishing = publishStatus === "publishing";
  const canPublish = dbAvailable && markdown.trim().length > 0 && !publishing && !drafting;

  const linkFor = (token: string) =>
    typeof window !== "undefined" ? `${window.location.origin}/study/${token}` : `/study/${token}`;

  async function draft() {
    if (drafting || publishing) return;
    setDraftStatus("drafting");
    setDraftError(null);
    try {
      const res = await fetch("/api/study-guide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, action: "draft" }),
      });
      const data = (await res.json().catch(() => ({}))) as { markdown?: string; error?: string };
      if (res.ok && typeof data.markdown === "string" && data.markdown.trim()) {
        // Fill for review — replaces the current draft (an explicit action, like
        // "Generate with AI" on a slide card). Nothing is saved by drafting.
        setMarkdown(data.markdown);
        setDraftStatus("idle");
        setPublishStatus("idle");
        setLastToken(null);
      } else {
        setDraftStatus("error");
        setDraftError(draftMessageFor(res.status, data.error));
      }
    } catch {
      setDraftStatus("error");
      setDraftError("Network error — try again.");
    }
  }

  async function publish() {
    if (!canPublish) return;
    setPublishStatus("publishing");
    setPublishError(null);
    setCopied(false);
    try {
      const res = await fetch("/api/study-guide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, action: "publish", title, markdown }),
      });
      const data = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
      if (res.ok && data.token) {
        setPublishStatus("published");
        setLastToken(data.token);
        setPublished((prev) => [
          { token: data.token as string, title: title.trim(), createdAt: Date.now() },
          ...prev,
        ]);
      } else {
        setPublishStatus("error");
        setPublishError(publishMessageFor(res.status, data.error));
      }
    } catch {
      setPublishStatus("error");
      setPublishError("Network error — try again.");
    }
  }

  async function copyLink(token: string) {
    try {
      await navigator.clipboard.writeText(linkFor(token));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable — the visible link can still be selected by hand */
    }
  }

  return (
    <section
      style={{
        padding: "20px 22px 22px",
        borderRadius: 18,
        background: "rgba(255,255,255,0.55)",
        border: "1px solid rgba(255,255,255,0.75)",
        backdropFilter: "blur(16px)",
        WebkitBackdropFilter: "blur(16px)",
        boxShadow: "0 10px 28px -18px rgba(60,55,45,0.4)",
        marginBottom: 22,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: "0.08em",
            color: "#5E5A52",
            background: "rgba(191,224,72,0.35)",
            padding: "3px 9px",
            borderRadius: 8,
            whiteSpace: "nowrap",
          }}
        >
          Study guide
        </span>
        <span style={{ fontSize: 14.5, color: "#2C2932", flex: 1, minWidth: 0 }}>
          Draft a handout from the whole deck, edit it, then publish a share link.
        </span>
        <button
          type="button"
          onClick={draft}
          disabled={drafting || publishing}
          title="AI drafts a Markdown study guide from the deck's material, notes, revealed poll, and audience question themes — it only fills the editor below for review (replaces the current draft). Publish persists it."
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            height: 32,
            padding: "0 13px",
            borderRadius: 10,
            border: "1px solid rgba(60,55,45,0.16)",
            cursor: drafting || publishing ? "default" : "pointer",
            background: drafting || publishing ? "rgba(60,55,45,0.05)" : "rgba(191,224,72,0.22)",
            color: drafting || publishing ? "#A29D92" : "#4C4A38",
            fontFamily: "inherit",
            fontSize: 13,
            fontWeight: 500,
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
        >
          {drafting ? "Drafting…" : markdown.trim() ? "✦ Redraft with AI" : "✦ Draft with AI"}
        </button>
      </div>

      <p style={{ margin: "0 0 14px", fontSize: 12.5, color: "#8A857C", lineHeight: 1.5 }}>
        The draft is never saved by itself — review and edit below, then Publish to mint a
        token-gated link anyone can open (and download offline).
      </p>

      {draftStatus === "error" && draftError && (
        <div
          style={{
            marginBottom: 14,
            padding: "8px 12px",
            borderRadius: 10,
            background: "rgba(194,59,39,0.07)",
            border: "1px solid rgba(194,59,39,0.22)",
            color: "#8F2C1D",
            fontSize: 13,
            lineHeight: 1.45,
          }}
        >
          {draftError}
        </div>
      )}

      {(markdown.trim().length > 0 || drafting) && (
        <>
          <label style={{ display: "flex", flexDirection: "column", gap: 7, marginBottom: 14 }}>
            <span style={{ fontSize: 12, fontWeight: 500, letterSpacing: "0.02em", color: "#6E6A62" }}>
              Handout title
            </span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value.slice(0, MAX_TITLE))}
              disabled={drafting}
              maxLength={MAX_TITLE}
              style={{
                height: 38,
                padding: "0 13px",
                borderRadius: 12,
                border: "1px solid rgba(60,55,45,0.18)",
                background: drafting ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.72)",
                fontFamily: "inherit",
                fontSize: 14,
                color: "#2C2A31",
                outline: "none",
                boxSizing: "border-box",
              }}
            />
          </label>

          <label style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            <span
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
                fontSize: 12,
                fontWeight: 500,
                letterSpacing: "0.02em",
                color: "#6E6A62",
              }}
            >
              Study guide (Markdown — edit freely before publishing)
              <span
                style={{ fontSize: 11, color: markdown.length > MAX_MARKDOWN ? "#C23B27" : "#A29D92" }}
              >
                {markdown.length.toLocaleString()} / {MAX_MARKDOWN.toLocaleString()}
              </span>
            </span>
            <textarea
              className="sme-textarea"
              value={markdown}
              onChange={(e) => setMarkdown(e.target.value)}
              disabled={drafting}
              rows={14}
              placeholder={drafting ? "Drafting from the deck…" : ""}
              style={{
                width: "100%",
                resize: "vertical",
                padding: "11px 13px",
                borderRadius: 12,
                border: "1px solid rgba(60,55,45,0.18)",
                background: drafting ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.72)",
                fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
                fontSize: 13,
                lineHeight: 1.55,
                color: "#2C2A31",
                outline: "none",
                boxSizing: "border-box",
              }}
            />
          </label>

          <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 14, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={publish}
              disabled={!canPublish || markdown.length > MAX_MARKDOWN}
              style={{
                height: 38,
                padding: "0 20px",
                borderRadius: 11,
                border: "none",
                cursor: canPublish && markdown.length <= MAX_MARKDOWN ? "pointer" : "default",
                background: canPublish && markdown.length <= MAX_MARKDOWN ? "#2C2A31" : "#B9B5AD",
                color: "#F4F2EC",
                fontFamily: "inherit",
                fontSize: 14,
                fontWeight: 500,
              }}
            >
              {publishing ? "Publishing…" : "Publish share link"}
            </button>
            {!dbAvailable && (
              <span style={{ fontSize: 13, color: "#C23B27" }}>
                Database unavailable — publishing disabled.
              </span>
            )}
            {publishStatus === "error" && publishError && (
              <span style={{ fontSize: 13, color: "#C23B27" }}>{publishError}</span>
            )}
          </div>

          {publishStatus === "published" && lastToken && (
            <div
              style={{
                marginTop: 14,
                padding: "12px 14px",
                borderRadius: 12,
                background: "rgba(191,224,72,0.16)",
                border: "1px solid rgba(140,170,40,0.4)",
                display: "flex",
                alignItems: "center",
                gap: 10,
                flexWrap: "wrap",
              }}
            >
              <span style={{ fontSize: 13, fontWeight: 600, color: "#4F7A2E", whiteSpace: "nowrap" }}>
                Published ✓
              </span>
              <code
                style={{
                  flex: 1,
                  minWidth: 180,
                  fontSize: 12.5,
                  color: "#3A372F",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {linkFor(lastToken)}
              </code>
              <button type="button" onClick={() => copyLink(lastToken)} style={smallBtn}>
                {copied ? "Copied ✓" : "Copy link"}
              </button>
              <a href={`/study/${lastToken}`} target="_blank" rel="noopener noreferrer" style={smallLink}>
                Open ↗
              </a>
            </div>
          )}
        </>
      )}

      {published.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <span style={{ fontSize: 12, fontWeight: 500, letterSpacing: "0.02em", color: "#6E6A62" }}>
            Published guides
          </span>
          <ul style={{ margin: "8px 0 0", padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 6 }}>
            {published.map((g) => (
              <li
                key={g.token}
                style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "#3A372F" }}
              >
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {g.title || "Study guide"}
                  <span style={{ color: "#9A958A" }}>
                    {" · "}
                    {new Date(g.createdAt).toLocaleDateString()}
                  </span>
                </span>
                <button type="button" onClick={() => copyLink(g.token)} style={smallBtn}>
                  Copy link
                </button>
                <a
                  href={`/study/${g.token}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={smallLink}
                >
                  Open ↗
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

const smallBtn: React.CSSProperties = {
  height: 28,
  padding: "0 12px",
  borderRadius: 9,
  border: "1px solid rgba(60,55,45,0.18)",
  background: "rgba(255,255,255,0.6)",
  color: "#4C4A38",
  fontFamily: "inherit",
  fontSize: 12.5,
  fontWeight: 500,
  cursor: "pointer",
  whiteSpace: "nowrap",
  flexShrink: 0,
};

const smallLink: React.CSSProperties = {
  fontSize: 12.5,
  fontWeight: 500,
  color: "#55701C",
  textDecoration: "none",
  whiteSpace: "nowrap",
  flexShrink: 0,
};
