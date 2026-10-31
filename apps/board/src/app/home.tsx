/**
 * The Lingtai home a page is of, inside the bar's brand (#767).
 *
 * Props and nothing else, and no import but React's: the page reads the
 * environment (`lib/home.ts`) and hands the home down, as `Projects` is handed
 * `app`. A server-only import reaching a `"use client"` graph is what the Next
 * build catches after the merge (#230) and `tsc` cannot, so this file is held
 * to importing neither `@lingtai/env` nor `"use client"` by a unit test.
 *
 * Drawn on every home, `~/.lingtai` included: two tabs on two homes are told
 * apart by reading, not by remembering which is the default. It is a child of
 * the brand and not a chip, because the bar carries four objects (`the-bar.md`).
 */
export function Home({ path, shown }: { path: string; shown: string }) {
  return (
    <span className="home mono" title={path}>
      {shown}
    </span>
  )
}
