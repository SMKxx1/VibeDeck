"use client";

// Presenter sign-in form. Viewers never see this — they go straight to the live
// deck at /. Styled to the warm "Solis" palette to match the dashboard it
// unlocks. The password form is the primary path; "Continue with Google" is a
// plain link to /api/auth/google/start (server-side Authorization-Code flow —
// no client SDK). The server page (app/login/page.tsx) passes down whether
// Google is configured plus the ?pending= / ?error= codes the OAuth callback
// redirects back with.

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

// ?error= codes minted by app/api/auth/google/callback → friendly copy.
function oauthErrorMessage(code: string): string {
  switch (code) {
    case "google_denied":
      return "Google sign-in was cancelled.";
    case "state_mismatch":
      return "That sign-in attempt expired — try again.";
    case "email_not_verified":
      return "Your Google email isn't verified. Verify it with Google, then try again.";
    case "google_failed":
      return "Google sign-in failed — try again.";
    default:
      return "Something went wrong — try again.";
  }
}

export function LoginForm({
  googleConfigured,
  pending,
  oauthError,
}: {
  googleConfigured: boolean;
  pending: boolean;
  oauthError: string | null;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(
    oauthError ? oauthErrorMessage(oauthError) : null,
  );
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
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

  const googleButton: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    height: 46,
    borderRadius: 12,
    border: "1px solid rgba(60,55,45,0.2)",
    background: googleConfigured ? "rgba(255,255,255,0.75)" : "rgba(255,255,255,0.4)",
    color: googleConfigured ? "#2C2A31" : "#A5A099",
    fontFamily: "inherit",
    fontSize: 15,
    fontWeight: 500,
    textDecoration: "none",
    cursor: googleConfigured ? "pointer" : "default",
  };

  const googleG = (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );

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

        {pending && (
          <div
            role="status"
            style={{
              padding: "12px 14px",
              borderRadius: 13,
              background: "rgba(191,224,72,0.22)",
              border: "1px solid rgba(140,160,40,0.4)",
              fontSize: 13.5,
              color: "#3A4018",
              lineHeight: 1.45,
            }}
          >
            Your account request is awaiting approval. You&apos;ll be able to sign in with Google
            once the owner approves it.
          </div>
        )}

        <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5, color: "#6E6A62" }}>
          Email
          <input
            style={field}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
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

        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ flex: 1, height: 1, background: "rgba(60,55,45,0.14)" }} />
          <span style={{ fontSize: 11.5, color: "#8A857C" }}>or</span>
          <div style={{ flex: 1, height: 1, background: "rgba(60,55,45,0.14)" }} />
        </div>

        {googleConfigured ? (
          // A plain navigation — /api/auth/google/start 302s to Google's consent
          // screen. Deliberately not a fetch: the whole flow is redirects.
          <a href="/api/auth/google/start" style={googleButton}>
            {googleG}
            Continue with Google
          </a>
        ) : (
          <div style={googleButton} title="Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to enable">
            {googleG}
            Google sign-in isn&apos;t configured
          </div>
        )}

        <Link href="/" style={{ fontSize: 12.5, color: "#8A857C", textDecoration: "none", textAlign: "center" }}>
          ← I&apos;m a viewer, take me to the deck
        </Link>
      </form>
    </main>
  );
}
