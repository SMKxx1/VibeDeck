"use client";

// The presenter console's dark chrome — the labels, the button base and the side-
// panel shell shared by the poll / Turn & Talk / Q&A panels and the console shell
// itself. Moved verbatim from PresenterConsole; single-panel styles live with
// their panel. Dark-only by design (UploadedDeckFrame keeps its own light set).

export function Label({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.16em", textTransform: "uppercase", color: "#9A958A" }}>{children}</div>;
}

export function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "#9A958A", marginBottom: 6 }}>
      {children}
    </div>
  );
}

export function btn(bg: string, fg: string): React.CSSProperties {
  return { height: 34, padding: "0 14px", borderRadius: 10, border: "none", cursor: "pointer", background: bg, color: fg, fontFamily: "inherit", fontSize: 13, fontWeight: 500 };
}

export const pollPanelWrap: React.CSSProperties = {
  flex: "0 0 330px",
  minWidth: 0,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  gap: 12,
  padding: 14,
  borderRadius: 12,
  background: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.12)",
};

export const pollScroll: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

export const pollTextarea: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "9px 11px",
  borderRadius: 9,
  resize: "vertical",
  border: "1px solid rgba(255,255,255,0.16)",
  background: "rgba(255,255,255,0.06)",
  color: "#F4F2EC",
  fontFamily: "inherit",
  fontSize: 13.5,
  lineHeight: 1.4,
  outline: "none",
};

export const pollIconBtn: React.CSSProperties = {
  width: 28,
  height: 28,
  flex: "0 0 auto",
  borderRadius: 8,
  border: "1px solid rgba(255,255,255,0.14)",
  background: "rgba(255,255,255,0.06)",
  color: "#C9C5BC",
  cursor: "pointer",
  fontSize: 14,
  lineHeight: 1,
  padding: 0,
};

export function draftBtn(loading: boolean): React.CSSProperties {
  return {
    height: 40,
    borderRadius: 10,
    border: "1px solid rgba(191,224,72,0.5)",
    background: loading ? "rgba(191,224,72,0.12)" : "rgba(191,224,72,0.18)",
    color: "#D6E88A",
    cursor: loading ? "default" : "pointer",
    fontFamily: "inherit",
    fontSize: 13.5,
    fontWeight: 600,
    opacity: loading ? 0.8 : 1,
  };
}

export function launchBtn(enabled: boolean): React.CSSProperties {
  return {
    height: 42,
    borderRadius: 10,
    border: "none",
    background: enabled ? "#BFE048" : "#3A3838",
    color: enabled ? "#1B1B20" : "#7A7770",
    cursor: enabled ? "pointer" : "default",
    fontFamily: "inherit",
    fontSize: 14,
    fontWeight: 600,
  };
}

export const pollErrorText: React.CSSProperties = {
  fontSize: 12,
  color: "#FF8A6B",
  fontWeight: 500,
};

export const pollExplain: React.CSSProperties = {
  fontSize: 12,
  color: "#9A958A",
  lineHeight: 1.5,
  fontStyle: "italic",
  padding: "8px 10px",
  borderRadius: 8,
  background: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.08)",
};
