/**
 * What `/img/docs/<name>` serves: one file in `doc/img/`, an SVG diagram or a PNG
 * screenshot, and nothing else. A name with a separator, a `..`, a capital or any
 * other extension has no type, so the route neither exports nor serves it.
 *
 * Its own module because a Next route file may export only the names Next knows.
 */
export function imageType(name: string): 'image/svg+xml; charset=utf-8' | 'image/png' | null {
  const match = /^[a-z0-9-]+\.(svg|png)$/.exec(name)
  if (match === null) return null
  return match[1] === 'svg' ? 'image/svg+xml; charset=utf-8' : 'image/png'
}
