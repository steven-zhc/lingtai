import type { ReactNode } from 'react'

/** The bar over `recipe.yml`: its name, its path, and whatever buttons the state needs. */
export function FileBar({ path, children }: { path: string; children?: ReactNode }) {
  return (
    <div className="rfile-bar">
      <b>recipe.yml</b>
      <small>{path}</small>
      {children}
    </div>
  )
}
