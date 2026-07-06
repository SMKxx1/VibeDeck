"use client";

// Presenter sign-in. Viewers never see this — they go straight to the live deck
// at /. Styled to the warm "Solis" palette to match the dashboard it unlocks.

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (res.ok) {
        router.push("/dashboard");
        router.refresh();
      } else {
        setError("Those credentials didn't match. Try again.");
        setBusy(false);
      }
    } catch {
      setError("Something went wrong. Try again.");
      setBusy(false);
    }
  }

  const field: React.CSSProperties = {
    width: "100%",
    height: 46,
    padding: "0 14px",
    borderRadius: 12,
    border: "1px solid rgba(60,55,45,0.18)",
    background: "rgba(255,255,255,0.7)",
    fontFamily: "inherit",
    fontSize: 15,
    color: "#2C2A31",
    outline: "none",
  };

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        background: "#ECEAE3",
        backgroundImage: "radial-gradient(rgba(40,38,32,0.045) 1px, transparent 1.4px)",
        backgroundSize: "22px 22px",
      }}
    >
      <form
        onSubmit={onSubmit}
        style={{
          width: "min(400px, 100%)",
          display: "flex",
          flexDirection: "column",
          gap: 16,
          padding: "34px 32px 30px",
          borderRadius: 22,
          background: "rgba(255,255,255,0.55)",
          border: "1px solid rgba(255,255,255,0.75)",
          backdropFilter: "blur(16px)",
          WebkitBackdropFilter: "blur(16px)",
          boxShadow: "0 24px 60px -30px rgba(60,55,45,0.55)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 4 }}>
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: 12,
              background: "rgba(255,255,255,0.7)",
              border: "1px solid rgba(255,255,255,0.85)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="#3A3A40" strokeWidth={1.1}>
              <circle cx="10" cy="10" r="3.1" />
              <g strokeLinecap="round">
                <path d="M10 1.4V4M10 16v2.6M1.4 10H4M16 10h2.6M3.9 3.9l1.8 1.8M14.3 14.3l1.8 1.8M16.1 3.9l-1.8 1.8M5.7 14.3l-1.8 1.8" />
              </g>
            </svg>
          </div>
          <div>
            <div style={{ fontSize: 18, fontWeight: 500, color: "#262229", lineHeight: 1.1 }}>Presenter sign-in</div>
            <div style={{ fontSize: 12.5, fontWeight: 300, color: "#8A857C" }}>Solis · your deck library</div>
          </div>
        </div>

        <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5, color: "#6E6A62" }}>
          Username
          <input
            style={field}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5, color: "#6E6A62" }}>
          Password
          <input
            type="password"
            style={field}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>

        {error && <div style={{ fontSize: 13, color: "#C23B27" }}>{error}</div>}

        <button
          type="submit"
          disabled={busy}
          style={{
            height: 46,
            marginTop: 4,
            borderRadius: 12,
            border: "none",
            background: busy ? "#54525A" : "#2C2A31",
            color: "#F4F2EC",
            fontFamily: "inherit",
            fontSize: 15,
            fontWeight: 500,
            cursor: busy ? "default" : "pointer",
          }}
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>

        <a href="/" style={{ fontSize: 12.5, color: "#8A857C", textDecoration: "none", textAlign: "center" }}>
          ← I'm a viewer, take me to the deck
        </a>
      </form>
    </main>
  );
}
