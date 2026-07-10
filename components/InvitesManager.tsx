"use client";

// Invitations — ADMIN ONLY (Phase 4). Rendered by app/dashboard/invites/page.tsx,
// which already gates admin access server-side; every fetch below still hits the
// server, which re-enforces the same admin boundary. Styled to the warm "Solis"
// palette (frosted glass over a dot-grid paper background) so it belongs to the
// same app as the deck library and the login screen.
//
// The invite token is a capability: whoever holds /signup?token=… can create the
// account. It's shown to this admin on purpose; it is never console.logged.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

// Mirrors lib/users Invite — redeclared here so this client module never imports
// the server-only users store. The GET returns these newest-first.
type Role = "admin" | "presenter";
interface Invite {
  token: string;
  email: string | null;
  role: Role;
  usedBy: string | null;
  createdAt: string;
  expiresAt: string;
}

type InviteStatus = "active" | "expired" | "used";

// The 201 POST body.
interface CreatedInvite {
  token: string;
  url: string; // e.g. "/signup?token=abc"
  role: Role;
}

// ---- palette ----------------------------------------------------------------

const INK = "#2C2A31";
const INK_SOFT = "#4A4750";
const MUTED = "#8A857C";
const LABEL = "#6E6A62";
const LIME = "#BFE048";
const CORAL = "#C23B27";
const PAPER = "#ECEAE3";

// Map a failed request onto a plain admin-facing sentence, same idea as
// DeckLibrary's adminErrorMessage.
function errorMessage(status: number, error?: string): string {
  if (status === 401) return "Session expired — sign in again.";
  if (status === 403) return "Admins only.";
  if (status === 503 || error === "database_unavailable") return "Database unavailable — try again.";
  return "Something went wrong — try again.";
}

function statusOf(inv: Invite, now: number): InviteStatus {
  if (inv.usedBy) return "used";
  if (new Date(inv.expiresAt).getTime() < now) return "expired";
  return "active";
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

// ---- shared styles ----------------------------------------------------------

const card: React.CSSProperties = {
  borderRadius: 20,
  background: "rgba(255,255,255,0.5)",
  border: "1px solid rgba(255,255,255,0.7)",
  backdropFilter: "blur(14px)",
  WebkitBackdropFilter: "blur(14px)",
  boxShadow: "0 18px 44px -26px rgba(60,55,45,0.5)",
};

const field: React.CSSProperties = {
  width: "100%",
  height: 46,
  padding: "0 14px",
  borderRadius: 12,
  border: "1px solid rgba(60,55,45,0.18)",
  background: "rgba(255,255,255,0.7)",
  fontFamily: "inherit",
  fontSize: 15,
  color: INK,
  outline: "none",
};

const labelText: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  fontSize: 12.5,
  color: LABEL,
};

// ---- copy-to-clipboard button -----------------------------------------------

// getText is a thunk so window.location.origin is only read at click time — never
// during (server-side) render, which would throw.
function CopyButton({
  getText,
  label = "Copy link",
  primary = false,
}: {
  getText: () => string;
  label?: string;
  primary?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  async function copy() {
    const text = getText();
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        setCopied(true);
      }
    } catch {
      // Clipboard blocked/unavailable — leave the label unchanged rather than lie.
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      className="iv-btn"
      style={{
        height: 34,
        padding: "0 13px",
        borderRadius: 10,
        border: primary ? "none" : "1px solid rgba(60,55,45,0.2)",
        background: primary ? INK : "rgba(255,255,255,0.6)",
        color: primary ? "#F4F2EC" : INK_SOFT,
        fontFamily: "inherit",
        fontSize: 13,
        fontWeight: 500,
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
    >
      {copied ? "Copied!" : label}
    </button>
  );
}

// ---- chips ------------------------------------------------------------------

function RoleChip({ role }: { role: Role }) {
  const admin = role === "admin";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        height: 22,
        padding: "0 9px",
        borderRadius: 999,
        fontSize: 11.5,
        fontWeight: 500,
        letterSpacing: "0.01em",
        color: admin ? "#3A3320" : INK_SOFT,
        background: admin ? "rgba(191,224,72,0.55)" : "rgba(255,255,255,0.65)",
        border: admin ? "1px solid rgba(140,160,40,0.45)" : "1px solid rgba(60,55,45,0.16)",
      }}
    >
      {admin ? "Admin" : "Presenter"}
    </span>
  );
}

function StatusChip({ status }: { status: InviteStatus }) {
  const style: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    height: 22,
    padding: "0 9px",
    borderRadius: 999,
    fontSize: 11.5,
    fontWeight: 500,
    letterSpacing: "0.01em",
  };
  if (status === "active") {
    return (
      <span style={{ ...style, background: LIME, color: "#2E3410", border: "1px solid rgba(140,160,40,0.5)" }}>
        Active
      </span>
    );
  }
  if (status === "used") {
    return (
      <span style={{ ...style, background: "rgba(44,42,49,0.9)", color: "#EDEBE4", border: "1px solid rgba(44,42,49,0.9)" }}>
        Used
      </span>
    );
  }
  return (
    <span style={{ ...style, background: "rgba(255,255,255,0.5)", color: MUTED, border: "1px solid rgba(60,55,45,0.16)" }}>
      Expired
    </span>
  );
}

// ---- one invite row ---------------------------------------------------------

function InviteRow({
  inv,
  now,
  onRevoke,
}: {
  inv: Invite;
  now: number;
  onRevoke: (token: string) => Promise<void>;
}) {
  const status = statusOf(inv, now);
  const [confirming, setConfirming] = useState(false);
  const [revoking, setRevoking] = useState(false);

  async function confirmRevoke() {
    setRevoking(true);
    try {
      await onRevoke(inv.token);
      // On success the parent removes the row, so no further state to reset here.
    } finally {
      setRevoking(false);
      setConfirming(false);
    }
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "14px 16px",
        borderTop: "1px solid rgba(60,55,45,0.1)",
        flexWrap: "wrap",
      }}
    >
      <div style={{ flex: "1 1 220px", minWidth: 0 }}>
        <div
          style={{
            fontSize: 14.5,
            fontWeight: 450,
            color: inv.email ? INK : MUTED,
            fontStyle: inv.email ? "normal" : "italic",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {inv.email ?? "Any email"}
        </div>
        <div style={{ marginTop: 3, fontSize: 12, color: MUTED }}>
          Created {fmtDate(inv.createdAt)} · Expires {fmtDate(inv.expiresAt)}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flex: "0 0 auto" }}>
        <RoleChip role={inv.role} />
        <StatusChip status={status} />
      </div>

      {status === "active" && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flex: "0 0 auto" }}>
          <CopyButton getText={() => `${window.location.origin}/signup?token=${inv.token}`} />
          {confirming ? (
            <>
              <button
                type="button"
                onClick={confirmRevoke}
                disabled={revoking}
                className="iv-btn"
                style={{
                  height: 34,
                  padding: "0 13px",
                  borderRadius: 10,
                  border: "none",
                  background: revoking ? "rgba(150,50,40,0.6)" : CORAL,
                  color: "#F6F1EF",
                  fontFamily: "inherit",
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: revoking ? "default" : "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                {revoking ? "Revoking…" : "Confirm"}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={revoking}
                className="iv-btn"
                style={{
                  height: 34,
                  padding: "0 13px",
                  borderRadius: 10,
                  border: "1px solid rgba(60,55,45,0.2)",
                  background: "rgba(255,255,255,0.6)",
                  color: INK_SOFT,
                  fontFamily: "inherit",
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="iv-btn"
              style={{
                height: 34,
                padding: "0 13px",
                borderRadius: 10,
                border: "1px solid rgba(194,59,39,0.35)",
                background: "rgba(255,255,255,0.6)",
                color: CORAL,
                fontFamily: "inherit",
                fontSize: 13,
                fontWeight: 500,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              Revoke?
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---- main -------------------------------------------------------------------

export function InvitesManager() {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create-form state.
  const [role, setRole] = useState<Role>("presenter");
  const [email, setEmail] = useState("");
  const [creating, setCreating] = useState(false);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [createdRole, setCreatedRole] = useState<Role | null>(null);

  // Recomputed each render so status chips reflect "now"; cheap for this list size.
  const now = Date.now();

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/invites", { cache: "no-store" });
      if (!res.ok) {
        let body: { error?: string } = {};
        try {
          body = await res.json();
        } catch {
          /* non-JSON error body */
        }
        setError(errorMessage(res.status, body.error));
        return;
      }
      const data = (await res.json()) as { invites: Invite[] };
      setInvites(data.invites ?? []);
      setError(null);
    } catch {
      setError(errorMessage(0));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const trimmed = email.trim();
      const res = await fetch("/api/admin/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role, email: trimmed ? trimmed : null }),
      });
      if (!res.ok) {
        let body: { error?: string } = {};
        try {
          body = await res.json();
        } catch {
          /* ignore */
        }
        setError(errorMessage(res.status, body.error));
        return;
      }
      const data = (await res.json()) as CreatedInvite;
      setCreatedUrl(`${window.location.origin}${data.url}`);
      setCreatedRole(data.role);
      setEmail("");
      // Re-fetch so the freshly minted invite appears in the list below.
      await load();
    } catch {
      setError(errorMessage(0));
    } finally {
      setCreating(false);
    }
  }

  const revoke = useCallback(async (token: string) => {
    setError(null);
    try {
      const res = await fetch(`/api/admin/invites?token=${encodeURIComponent(token)}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setInvites((prev) => prev.filter((i) => i.token !== token));
        return;
      }
      if (res.status === 404) {
        // Already used or gone — reconcile by dropping it and refreshing.
        setInvites((prev) => prev.filter((i) => i.token !== token));
        await load();
        return;
      }
      let body: { error?: string } = {};
      try {
        body = await res.json();
      } catch {
        /* ignore */
      }
      setError(errorMessage(res.status, body.error));
    } catch {
      setError(errorMessage(0));
    }
  }, [load]);

  const hasInvites = invites.length > 0;
  const createdCopy = useMemo(() => createdUrl ?? "", [createdUrl]);

  return (
    <main
      style={{
        minHeight: "100vh",
        padding: "40px 22px 64px",
        display: "flex",
        justifyContent: "center",
        background: PAPER,
        backgroundImage: "radial-gradient(rgba(40,38,32,0.045) 1px, transparent 1.4px)",
        backgroundSize: "22px 22px",
        color: INK,
      }}
    >
      <div style={{ width: "100%", maxWidth: 760, display: "flex", flexDirection: "column", gap: 20 }}>
        {/* header */}
        <div>
          <Link
            href="/dashboard"
            style={{ fontSize: 13, color: MUTED, textDecoration: "none" }}
          >
            ← Back to library
          </Link>
          <h1 style={{ margin: "14px 0 6px", fontSize: 27, fontWeight: 500, letterSpacing: "0.01em", color: "#262229" }}>
            Invitations
          </h1>
          <p style={{ margin: 0, fontSize: 14, fontWeight: 300, color: MUTED }}>
            Invite presenters and admins to Solis.
          </p>
        </div>

        {/* error banner */}
        {error && (
          <div
            role="alert"
            style={{
              ...card,
              padding: "13px 16px",
              fontSize: 13.5,
              color: CORAL,
              background: "rgba(255,255,255,0.6)",
            }}
          >
            {error}
          </div>
        )}

        {/* create-invite form */}
        <form onSubmit={onCreate} style={{ ...card, padding: "22px 22px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ fontSize: 15.5, fontWeight: 500, color: "#262229" }}>Create an invite</div>

          <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
            <label style={{ ...labelText, flex: "0 0 180px" }}>
              Role
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as Role)}
                style={{ ...field, cursor: "pointer" }}
              >
                <option value="presenter">Presenter</option>
                <option value="admin">Admin</option>
              </select>
            </label>

            <label style={{ ...labelText, flex: "1 1 260px", minWidth: 220 }}>
              Email (optional)
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Any email (leave blank for an open invite)"
                autoComplete="off"
                style={field}
              />
            </label>
          </div>

          <div>
            <button
              type="submit"
              disabled={creating}
              className="iv-btn"
              style={{
                height: 46,
                padding: "0 22px",
                borderRadius: 12,
                border: "none",
                background: creating ? "#54525A" : INK,
                color: "#F4F2EC",
                fontFamily: "inherit",
                fontSize: 15,
                fontWeight: 500,
                cursor: creating ? "default" : "pointer",
              }}
            >
              {creating ? "Creating…" : "Create invite"}
            </button>
          </div>

          {createdUrl && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "13px 15px",
                borderRadius: 13,
                background: "rgba(191,224,72,0.22)",
                border: "1px solid rgba(140,160,40,0.4)",
                flexWrap: "wrap",
              }}
            >
              <div style={{ flex: "1 1 240px", minWidth: 0 }}>
                <div style={{ fontSize: 11.5, fontWeight: 500, color: "#4E5622", marginBottom: 3 }}>
                  New {createdRole === "admin" ? "admin" : "presenter"} invite — share this link
                </div>
                <div
                  style={{
                    fontSize: 13,
                    color: INK,
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {createdUrl}
                </div>
              </div>
              <CopyButton getText={() => createdCopy} primary />
            </div>
          )}
        </form>

        {/* invites list */}
        <div style={{ ...card, padding: 0, overflow: "hidden" }}>
          <div style={{ padding: "16px 18px 14px", display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
            <div style={{ fontSize: 15.5, fontWeight: 500, color: "#262229" }}>All invites</div>
            {!loading && hasInvites && (
              <div style={{ fontSize: 12.5, color: MUTED }}>
                {invites.length} {invites.length === 1 ? "invite" : "invites"}
              </div>
            )}
          </div>

          {loading ? (
            <div style={{ padding: "26px 18px 30px", fontSize: 13.5, color: MUTED, borderTop: "1px solid rgba(60,55,45,0.1)" }}>
              Loading invites…
            </div>
          ) : hasInvites ? (
            invites.map((inv) => (
              <InviteRow key={inv.token} inv={inv} now={now} onRevoke={revoke} />
            ))
          ) : (
            <div
              style={{
                padding: "32px 18px 36px",
                textAlign: "center",
                borderTop: "1px solid rgba(60,55,45,0.1)",
              }}
            >
              <div style={{ fontSize: 14.5, color: INK_SOFT, marginBottom: 4 }}>No invites yet</div>
              <div style={{ fontSize: 13, color: MUTED }}>
                Create one above to invite a presenter or admin.
              </div>
            </div>
          )}
        </div>
      </div>

      <style>{`
        .iv-btn:hover:not(:disabled) { filter: brightness(0.97); }
        .iv-btn { transition: filter 120ms ease; }
      `}</style>
    </main>
  );
}
