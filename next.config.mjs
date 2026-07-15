/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
};

export default nextConfig;
