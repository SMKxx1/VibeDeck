"use client";

// Invite-redemption page. A logged-out invited user opens /signup?token=<token>
// (that URL is minted by the admin invites UI) and creates their account here.
// useSearchParams() must live inside a <Suspense> boundary or `next build` fails
// with a prerender error, so the form is split into its own component.

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

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

function Shell({ children }: { children: React.ReactNode }) {
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
      {children}
    </main>
  );
}

function Card({ children, onSubmit }: { children: React.ReactNode; onSubmit?: (e: React.FormEvent) => void }) {
  const cardStyle: React.CSSProperties = {
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
  };
  if (onSubmit) {
    return (
      <form onSubmit={onSubmit} style={cardStyle}>
        {children}
      </form>
    );
  }
  return <div style={cardStyle}>{children}</div>;
}

function Header({ title, subtitle }: { title: string; subtitle: string }) {
  return (
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
        <div style={{ fontSize: 18, fontWeight: 500, color: "#262229", lineHeight: 1.1 }}>{title}</div>
        <div style={{ fontSize: 12.5, fontWeight: 300, color: "#8A857C" }}>{subtitle}</div>
      </div>
    </div>
  );
}

function BackToSignIn() {
  return (
    <a href="/login" style={{ fontSize: 12.5, color: "#8A857C", textDecoration: "none", textAlign: "center" }}>
      ← Back to sign in
    </a>
  );
}

function SignupForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // No token → this link can't redeem an invite. Show a clear dead-end, not the form.
  if (!token) {
    return (
      <Shell>
        <Card>
          <Header title="Invite link incomplete" subtitle="Solis · you've been invited" />
          <div style={{ fontSize: 13.5, color: "#6E6A62", lineHeight: 1.5 }}>
            This signup link is missing its invite token. Ask your admin for a fresh link.
          </div>
          <BackToSignIn />
        </Card>
      </Shell>
    );
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, email, password }),
      });
      if (res.ok) {
        router.push("/dashboard");
        router.refresh();
        return;
      }
      const { error: code } = await res.json().catch(() => ({}));
      setError(mapError(code, res.status));
      setBusy(false);
    } catch {
      setError("Couldn't create your account. Try again.");
      setBusy(false);
    }
  }

  return (
    <Shell>
      <Card onSubmit={onSubmit}>
        <Header title="Create your account" subtitle="Solis · you've been invited" />

        <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5, color: "#6E6A62" }}>
          Email
          <input
            type="email"
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
            autoComplete="new-password"
            minLength={8}
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
          {busy ? "Creating account…" : "Create account"}
        </button>

        <BackToSignIn />
      </Card>
    </Shell>
  );
}

function mapError(code: unknown, status: number): string {
  switch (code) {
    case "email_mismatch":
      return "This invite was issued for a different email address.";
    case "email_taken":
      return "An account with that email already exists — try signing in instead.";
    case "weak_password":
      return "Password must be at least 8 characters.";
    case "invalid_email":
      return "Enter a valid email address.";
    case "missing_token":
      return "This signup link is missing its invite token.";
    case "rate_limited":
      return "Too many attempts — wait a few minutes and try again.";
    case "database_unavailable":
      return "Something went wrong on our end. Try again shortly.";
    case "invalid_invite":
      return "This invite link is invalid, already used, or expired.";
    default:
      break;
  }
  if (status === 429) return "Too many attempts — wait a few minutes and try again.";
  if (status === 503) return "Something went wrong on our end. Try again shortly.";
  if (status === 400) return "This invite link is invalid, already used, or expired.";
  return "Couldn't create your account. Try again.";
}

export default function SignupPage() {
  return (
    <Suspense fallback={<Shell>{null}</Shell>}>
      <SignupForm />
    </Suspense>
  );
}
