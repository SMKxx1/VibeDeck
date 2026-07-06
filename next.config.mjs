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
};

export default nextConfig;
