/**
 * The recipe text with one host added to `sandbox.network.allow` (#1162), for the editor to open on as a draft.
 *
 * Pure and never a write: the form runs it on its own current body (so earlier unsaved edits stay) while `loaded`
 * stays the file's own bytes, so Save still compares against the disk. `parseDocument` keeps comments and layout, and `setIn` creates the
 * block when it is absent (which turns the sandbox on, as writing the block always does).
 */
import { parseDocument } from 'yaml'

import { isNetworkEntry } from './sandbox-block.ts'

/** The cloud-metadata addresses: never offered as an allowed host. */
const METADATA = new Set(['169.254.169.254', 'fd00:ec2::254', 'metadata.google.internal'])

/** Null where there is nothing to draft: a host the recipe would refuse, one already listed, or text that does not parse. */
export function withAllowedHost(text: string, host: string): string | null {
  if (!isNetworkEntry(host) || METADATA.has(host.toLowerCase())) return null
  const doc = parseDocument(text)
  if (doc.errors.length > 0) return null
  try {
    const path = ['sandbox', 'network', 'allow']
    const listed = doc.getIn(path)
    const has = (listed as { toJSON?: () => unknown } | null | undefined)?.toJSON?.()
    if (Array.isArray(has)) {
      if (has.includes(host)) return null
      doc.addIn(path, host)
    } else {
      doc.setIn(path, [host])
    }
    return doc.toString()
  } catch {
    return null
  }
}
