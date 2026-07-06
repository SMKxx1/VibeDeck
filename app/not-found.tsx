import Link from "next/link";

export default function NotFound() {
  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        textAlign: "center",
        padding: 24,
      }}
    >
      <h1 style={{ fontSize: 48, fontWeight: 800, margin: 0 }}>Not found</h1>
      <p style={{ color: "var(--muted)", fontSize: 18, margin: 0 }}>
        That deck doesn&rsquo;t exist (or hasn&rsquo;t been deployed yet).
      </p>
      <Link
        href="/"
        style={{
          marginTop: 8,
          fontSize: 16,
          fontWeight: 700,
          color: "var(--teal)",
          textDecoration: "none",
        }}
      >
        ← Back to the library
      </Link>
    </main>
  );
}
