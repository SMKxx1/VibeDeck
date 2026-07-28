"use client";

// The presenter's Turn & Talk panel — compose form or the running countdown +
// Regroup. Moved verbatim from PresenterConsole; the shell owns the live activity
// (it rides the session poll) and every /api/activity call.

import { useEffect, useRef, useState } from "react";
import { useNow } from "../useNow";
import { ACTIVITY_PRESETS, type ActivityFollowUp } from "./shared";
import {
  FieldLabel,
  Label,
  btn,
  launchBtn,
  pollErrorText,
  pollExplain,
  pollIconBtn,
  pollPanelWrap,
  pollScroll,
  pollTextarea,
} from "./chrome";

// The active Turn & Talk activity — set via /api/activity and delivered on the
// same /api/session poll. Everyone (this console included) counts down
// CLIENT-SIDE from `endsAt`; "Regroup" clears it everywhere at once.
export interface Activity {
  id: string;
  prompt: string;
  endsAt: number; // epoch ms
  followUp: ActivityFollowUp | null;
  at: number;
}

// The Turn & Talk panel. No active activity → the compose form (prompt +
// duration presets + optional follow-up). Active → the prompt, a live MM:SS
// countdown (client-side from endsAt) and the Regroup button, which ends the
// activity on every screen at once (and, for a "poll" follow-up, opens the
// reviewed ✨ poll-draft flow — handled by the parent). Compose state is local;
// the parent owns the live activity (it rides the session poll).
export function ActivityPanel({
  activity,
  onStart,
  onRegroup,
  onDismiss,
}: {
  activity: Activity | null;
  onStart: (prompt: string, durationSec: number, followUp: ActivityFollowUp | null) => Promise<boolean>;
  onRegroup: () => void;
  onDismiss: () => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [durationSec, setDurationSec] = useState(300);
  const [followUp, setFollowUp] = useState<ActivityFollowUp | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(500);

  // When an activity ends/clears, reset the compose form for the next one
  // (mirrors the poll panel's blank-slate reset).
  const hadActivityRef = useRef(false);
  useEffect(() => {
    if (activity) {
      hadActivityRef.current = true;
      return;
    }
    if (hadActivityRef.current) {
      hadActivityRef.current = false;
      setPrompt("");
      setFollowUp(null);
      setError(null);
    }
  }, [activity]);

  const canStart = prompt.trim().length > 0 && !starting;
  async function start() {
    if (!canStart) return;
    setStarting(true);
    setError(null);
    const ok = await onStart(prompt.trim(), durationSec, followUp);
    setStarting(false);
    if (!ok) setError("Couldn't start — try again.");
  }

  const remaining = activity ? activity.endsAt - now : 0;
  const done = remaining <= 0;
  const secs = Math.max(0, Math.ceil(remaining / 1000));
  const mm = String(Math.floor(secs / 60)).padStart(2, "0");
  const ss = String(secs % 60).padStart(2, "0");

  return (
    <div style={pollPanelWrap}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Label>Turn &amp; talk</Label>
        <button onClick={onDismiss} title="Hide panel" aria-label="Hide Turn & Talk panel" style={pollIconBtn}>
          ✕
        </button>
      </div>

      {activity ? (
        <div style={pollScroll}>
          <div style={{ fontSize: 15, fontWeight: 500, color: "#F4F2EC", lineHeight: 1.45, whiteSpace: "pre-wrap" }}>
            {activity.prompt}
          </div>
          <div style={activityCountdown(done)}>{done ? "Time's up" : `${mm}:${ss}`}</div>
          <div style={{ fontSize: 12, fontWeight: 500, color: done ? "#F0B24A" : "#9A958A" }}>
            {done
              ? "The room sees “time's up” — regroup to clear it."
              : "Live on every viewer's screen — everyone counts down together."}
          </div>
          {activity.followUp === "poll" && (
            <div style={pollExplain}>Regrouping opens an AI poll draft on this slide for your review.</div>
          )}
          {activity.followUp === "pinboard" && (
            <div style={pollExplain}>Viewers see a nudge to share their link on the pinboard afterwards.</div>
          )}
          <button
            onClick={onRegroup}
            style={{ ...btn("#BFE048", "#1B1B20"), height: 42, fontWeight: 600 }}
            title="End the activity on every screen at once"
          >
            {activity.followUp === "poll" ? "⏹ Regroup & draft poll" : "⏹ Regroup"}
          </button>
        </div>
      ) : (
        <div style={pollScroll}>
          <div>
            <FieldLabel>Prompt</FieldLabel>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Discuss with your neighbor…"
              maxLength={500}
              rows={3}
              style={pollTextarea}
            />
          </div>

          <div>
            <FieldLabel>Duration</FieldLabel>
            <div style={{ display: "flex", gap: 8 }}>
              {ACTIVITY_PRESETS.map((p) => (
                <button
                  key={p.sec}
                  type="button"
                  onClick={() => setDurationSec(p.sec)}
                  aria-pressed={durationSec === p.sec}
                  style={activityChoice(durationSec === p.sec)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <FieldLabel>Afterwards (optional)</FieldLabel>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" onClick={() => setFollowUp(null)} aria-pressed={followUp === null} style={activityChoice(followUp === null)}>
                Nothing
              </button>
              <button type="button" onClick={() => setFollowUp("poll")} aria-pressed={followUp === "poll"} style={activityChoice(followUp === "poll")}>
                📊 Poll
              </button>
              <button type="button" onClick={() => setFollowUp("pinboard")} aria-pressed={followUp === "pinboard"} style={activityChoice(followUp === "pinboard")}>
                📌 Pinboard
              </button>
            </div>
          </div>

          {error && <div style={pollErrorText}>{error}</div>}
          <button onClick={() => void start()} disabled={!canStart} style={launchBtn(canStart)}>
            {starting ? "Starting…" : "⏱ Start Turn & Talk"}
          </button>
        </div>
      )}
    </div>
  );
}

function activityCountdown(done: boolean): React.CSSProperties {
  return {
    fontVariantNumeric: "tabular-nums",
    fontSize: done ? 22 : 42,
    fontWeight: 600,
    letterSpacing: done ? "0" : "0.03em",
    lineHeight: 1.1,
    color: done ? "#F0B24A" : "#BFE048",
  };
}

function activityChoice(on: boolean): React.CSSProperties {
  return {
    flex: 1,
    height: 34,
    borderRadius: 9,
    border: on ? "1px solid #BFE048" : "1px solid rgba(255,255,255,0.16)",
    background: on ? "rgba(191,224,72,0.22)" : "rgba(255,255,255,0.06)",
    color: on ? "#D6E88A" : "#C9C5BC",
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: 12.5,
    fontWeight: 600,
    whiteSpace: "nowrap",
  };
}
