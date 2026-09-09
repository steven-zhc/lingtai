import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import "./globals.css";

/**
 * The typefaces the design asks for, self-hosted.
 *
 * The stylesheet named "IBM Plex Sans" from the start and nothing ever loaded
 * it, so every rule fell through to `system-ui` and the board looked like a
 * different design than the one it was written against.
 *
 * `next/font` rather than a `<link>` to Google: it copies the files into the
 * build, so the board still renders as designed on a machine with no network —
 * which is most of what a local operator console is for.
 */
const sans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
  display: "swap",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Lingtai",
  description: "Event-sourced scheduler for autonomous code agents",
  /**
   * `public/logo.png` and `public/logo-dark.png` are copies of the two files in
   * `doc/` — a Next app serves its own `public/`, and reaching out of the app
   * for an asset is not something the build will do.
   *
   * Two entries because the mark is ink on a transparent ground: the near-black
   * one disappears in a dark tab strip and the light one disappears in a light
   * one. The dark-ground file is declared first so that the last entry — which
   * is what a browser that ignores `media` on an icon settles on — is the
   * dark-ink mark, right for the light tab strip that is the common case.
   */
  icons: {
    icon: [
      { url: "/logo-dark.png", type: "image/png", media: "(prefers-color-scheme: dark)" },
      { url: "/logo.png", type: "image/png", media: "(prefers-color-scheme: light)" },
    ],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
