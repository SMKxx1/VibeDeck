import type { Metadata, Viewport } from "next";
import { Outfit } from "next/font/google";
import "./globals.css";

// The design's UI typeface (Deck Library.dc.html + Main Slide.dc.html use Outfit).
// Self-hosted by next/font — no runtime CDN.
const outfit = Outfit({
  subsets: ["latin"],
  weight: ["200", "300", "400", "500", "600"],
  variable: "--font-outfit",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Class Presentations",
    template: "%s · Class Presentations",
  },
  description:
    "A library of class presentations with a presenter view and an AI sidebar grounded in the slides.",
};

export const viewport: Viewport = {
  themeColor: "#ECEAE3",
  width: "device-width",
  initialScale: 1,
  // The slide canvas scales itself; never let the browser zoom away legibility.
  maximumScale: 5,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={outfit.variable}>
      <body>{children}</body>
    </html>
  );
}
