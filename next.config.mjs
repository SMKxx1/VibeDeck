/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Hide the on-screen Next.js dev indicator (the little "N" badge). It never
  // ships to production anyway; this just removes it while developing.
  devIndicators: false,
  // Pin file-tracing to this project. A stray lockfile in the home directory
  // otherwise makes Next infer the wrong workspace root.
  outputFileTracingRoot: import.meta.dirname,
  // Keep the global bundle lean. Heavy animation/WebGL libraries (GSAP, PixiJS,
  // Three.js, Vanta) must be lazy-loaded per slide as islands — never imported
  // globally — per slide-system-rules.md §7.
  experimental: {
    // Next 15.5 truncates request bodies passing through middleware at 10MB by
    // default; our middleware matcher covers /api/*, so a Deck Asset Vault
    // upload larger than 10MB arrived truncated (a corrupt image sharp then
    // rejected as "unsupported"). Raise the cap just above the vault's own 50MB
    // MAX_RAW_BYTES ceiling so large originals reach the handler intact — every
    // route still enforces its own tighter Content-Length gate (upload/import/
    // draft cap at 2MB/500KB), so this only unblocks the asset route.
    middlewareClientMaxBodySize: "55mb",
  },
  async headers() {
    const mainAppHeaders = [
      {
        key: "Content-Security-Policy",
        // Deliberately limited to directives that do not require unsafe-inline.
        // Script/style nonces can be rolled out separately without weakening the
        // immediately useful anti-framing, base, object, and form protections.
        // frame-ancestors must be 'self', NOT 'none': the app frames its OWN
        // origin — LiveDeck/PresenterConsole/SlideMetaEditor iframe the embed
        // deck's static html (e.g. /decks/build-host-website/index.html), so
        // 'none' breaks the main live view with a full-page "refused to
        // connect". 'self' keeps the clickjacking protection (no other origin
        // may frame us) without blocking first-party framing.
        value: "base-uri 'self'; form-action 'self'; frame-ancestors 'self'; object-src 'none'",
      },
      { key: "X-Frame-Options", value: "SAMEORIGIN" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      {
        key: "Permissions-Policy",
        value: "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
      },
      { key: "X-DNS-Prefetch-Control", value: "off" },
      { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
    ];

    return [
      {
        // /d-content has its own stricter CSP and intentionally permits framing
        // by APP_ORIGIN. /d-assets has route-specific cross-origin policy too.
        source: "/((?!d-content/|d-assets/).*)",
        headers: mainAppHeaders,
      },
      ...(process.env.NODE_ENV === "production"
        ? [
            {
              source: "/:path*",
              headers: [
                {
                  key: "Strict-Transport-Security",
                  // Do not includeSubDomains/preload until every sibling host has
                  // been explicitly audited for permanent HTTPS support.
                  value: "max-age=31536000",
                },
              ],
            },
          ]
        : []),
    ];
  },
};

export default nextConfig;
