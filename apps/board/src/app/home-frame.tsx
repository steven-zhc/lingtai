import type { ReactNode } from 'react'

/**
 * The home page's frame (#939): one column at least the window's height, holding
 * `<main>` and then the footer, so a quiet board ends with the footer on the
 * first screen and a full one grows the page and the footer follows the last
 * card. The footer is a sibling of `<main>`, not inside it: a `<footer>` inside
 * `<main>` has no `contentinfo` role. The sizing is in `.home` in globals.css.
 */
export function HomeFrame({ children, footer }: { children: ReactNode; footer: ReactNode }) {
  return (
    <div className="home">
      <main>{children}</main>
      {footer}
    </div>
  )
}
