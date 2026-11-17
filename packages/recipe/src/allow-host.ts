/**
 * The recipe text with one host added to `sandbox.network.allow` (#1162), for the editor to open on as a draft.
 *
 * Pure and never a write: the form runs it on its own current body (so earlier unsaved edits stay) while `loaded`
 * stays the file's own bytes, so Save still compares against the disk. `parseDocument` keeps comments and layout, and `setIn` creates the
 * block when it is absent (which turns the sandbox on, as writing the block always does).
 */
import { LineCounter, isMap, isScalar, isSeq, parseDocument, type Document } from 'yaml'

import { isNetworkEntry } from './sandbox-block.ts'

/** The cloud-metadata addresses: never offered as an allowed host. */
const METADATA = new Set(['169.254.169.254', 'fd00:ec2::254', 'metadata.google.internal'])

/** What drafting did: the host added (with the 1-based lines it put in `text`), or already there (its line in the text given). */
export type AllowedHost =
  | { readonly kind: 'added'; readonly text: string; readonly lines: readonly number[] }
  | { readonly kind: 'listed'; readonly lines: readonly number[] }

const PATH = ['sandbox', 'network', 'allow']

/** The line of the key `key` in the map at `at`, or null. */
function keyLine(doc: Document, at: readonly string[], key: string, lc: LineCounter): number | null {
  const map = at.length === 0 ? doc.contents : doc.getIn(at, true)
  if (!isMap(map)) return null
  const pair = map.items.find((p) => isScalar(p.key) && p.key.value === key)
  const off = isScalar(pair?.key) ? pair.key.range?.[0] : undefined
  return off === undefined ? null : lc.linePos(off).line
}

/** The line of the `allow` item whose value is `host`; a flow list answers the `allow:` line. */
function hostLine(doc: Document, host: string, lc: LineCounter): number | null {
  const seq = doc.getIn(PATH, true)
  if (!isSeq(seq)) return null
  const item = seq.items.find((i) => isScalar(i) && i.value === host)
  const off = isScalar(item) ? item.range?.[0] : undefined
  if (off !== undefined) return lc.linePos(off).line
  return keyLine(doc, PATH.slice(0, 2), 'allow', lc)
}

const ascending = (xs: readonly (number | null)[]): number[] =>
  [...new Set(xs.filter((n): n is number => n !== null))].sort((a, b) => a - b)

/** Null where there is nothing to draft: a host the recipe would refuse, or text that does not parse. */
export function withAllowedHost(text: string, host: string): AllowedHost | null {
  if (!isNetworkEntry(host) || METADATA.has(host.toLowerCase())) return null
  const doc = parseDocument(text)
  if (doc.errors.length > 0) return null
  try {
    const listed = doc.getIn(PATH)
    const has = (listed as { toJSON?: () => unknown } | null | undefined)?.toJSON?.()
    if (Array.isArray(has) && has.includes(host)) {
      const lc = new LineCounter()
      const again = parseDocument(text, { lineCounter: lc })
      return { kind: 'listed', lines: ascending([hostLine(again, host, lc)]) }
    }
    // What the edit creates: each of these keys that was not there before.
    const created = PATH.filter((_, i) => !doc.hasIn(PATH.slice(0, i + 1)))
    if (Array.isArray(has)) doc.addIn(PATH, host)
    else doc.setIn(PATH, [host])
    const next = doc.toString()
    let lines: number[] = []
    try {
      const lc = new LineCounter()
      const after = parseDocument(next, { lineCounter: lc })
      const keys = created.map((k) => keyLine(after, PATH.slice(0, PATH.indexOf(k)), k, lc))
      const found = [...keys, hostLine(after, host, lc)]
      lines = found.includes(null) ? [] : ascending(found)
    } catch {
      lines = []
    }
    return { kind: 'added', text: next, lines }
  } catch {
    return null
  }
}
