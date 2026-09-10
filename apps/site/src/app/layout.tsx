import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
/**
 * The product's stylesheet, imported and not copied.
 *
 * Every colour, every card, every lane on this site is the board's own — the
 * hero renders `.col`, `.card` and `.pill` because those *are* the board, not
 * because they were reproduced to look like it. A site that looks unlike the
 * product is a promise the product breaks, and a second stylesheet claiming to
 * hold the same palette is a second truth waiting to drift from the first.
 *
 * `site.css` comes after and adds only what a page has and a console does not:
 * a measure, a hero, and one coral thing.
 */
import "../../../board/src/app/globals.css";
import "./site.css";

/**
 * The two faces the product uses, self-hosted, exactly as the board loads them
 * — `next/font` copies the files into the build, so the site renders as
 * designed without asking Google for anything at render.
 *
 * No serif, including in the long documentation. It would read a little better
 * and it is the one move that would make this look like every other docs site.
 * Comfort comes from measure and leading; see `--measure` in `site.css`.
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
  title: {
    default: "Lingtai — the harness you put around a coding agent",
    template: "%s — Lingtai",
  },
  description:
    "Lingtai takes issues one at a time, gives each a disposable worktree and a filtered environment, holds it at the gates your repository defines, and merges only what passes them.",
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
