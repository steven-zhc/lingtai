/**
 * Reading what srt refused (#1156). Pure: no srt, no process. Experiment 017 recorded one violation shape; srt
 * 0.0.83 writes three (`sandbox-manager.js`), and anything else is kept whole under host *unknown*.
 */

/** Hosts a run reaches for telemetry, matched the way `allowedDomains` entries are: `*.x` is a subdomain, never `x`. */
export const TELEMETRY_HOSTS: readonly string[] = ['sentry.io', '*.sentry.io']

export const isTelemetryHost = (host: string): boolean => {
  // srt matches the canonical hostname, so a rooted `sentry.io.` is `sentry.io`.
  const h = host.toLowerCase().replace(/\.+$/, '')
  return TELEMETRY_HOSTS.some((p) => (p.startsWith('*.') ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p))
}

export interface ParsedViolation {
  readonly host: string | null
  readonly port: number | null
}

const hostPort = (target: string): ParsedViolation | undefined => {
  const i = target.lastIndexOf(':')
  if (i <= 0) return undefined
  const host = target.slice(0, i).replace(/^\[/, '').replace(/\]$/, '')
  const portText = target.slice(i + 1)
  if (host === '' || !/^\d{1,5}$/.test(portText)) return undefined
  return { host, port: Number(portText) }
}

const UNKNOWN: ParsedViolation = { host: null, port: null }

/** `deny network-outbound h:p (…)`, `deny socks-tunnel h:p (…)`, `deny http-request METHOD target (…)`. */
export const parseViolationLine = (line: string): ParsedViolation => {
  const t = /^deny (?:network-outbound|socks-tunnel) (\S+)(?: \(.*\))?$/.exec(line.trim())
  if (t?.[1] !== undefined) return hostPort(t[1]) ?? UNKNOWN
  const h = /^deny http-request \S+ (\S+)(?: \(.*\))?$/.exec(line.trim())
  if (h?.[1] !== undefined) {
    try {
      const u = new URL(h[1])
      const host = u.hostname.replace(/^\[/, '').replace(/\]$/, '')
      const port = u.port !== '' ? Number(u.port) : u.protocol === 'https:' ? 443 : u.protocol === 'http:' ? 80 : null
      return host === '' ? UNKNOWN : { host, port }
    } catch {
      return UNKNOWN
    }
  }
  return UNKNOWN
}

export interface RefusedEntry {
  readonly host: string | null
  readonly port: number | null
  /** Set only when the line could not be parsed: kept whole. */
  readonly line?: string
  readonly count: number
  readonly firstAt: string
  readonly telemetry: boolean
}

/** One entry per `(host, port)`, an unparsed line by its exact text. Order is first seen. */
export const groupViolations = (
  violations: readonly { readonly line: string; readonly timestamp: Date }[],
): RefusedEntry[] => {
  const byKey = new Map<string, RefusedEntry>()
  for (const v of violations) {
    const p = parseViolationLine(v.line)
    const key = p.host === null ? `line:${v.line}` : `${p.host}:${p.port ?? ''}`
    const at = v.timestamp.toISOString()
    const prev = byKey.get(key)
    if (prev === undefined) {
      byKey.set(key, {
        host: p.host,
        port: p.port,
        ...(p.host === null ? { line: v.line } : {}),
        count: 1,
        firstAt: at,
        telemetry: p.host !== null && isTelemetryHost(p.host),
      })
    } else {
      byKey.set(key, { ...prev, count: prev.count + 1, firstAt: at < prev.firstAt ? at : prev.firstAt })
    }
  }
  return [...byKey.values()]
}

/**
 * srt's store size: `this.maxSize = 100` in `sandbox-violation-store.js`, and it keeps the newest 100 across every
 * command. Every entry added since a count is still held exactly when no more than this many were added.
 */
export const SRT_STORE_SIZE = 100

/** `complete` is false when the total count moved by more than the store holds, or went backwards (a `reset`). */
export const isComplete = (before: number, after: number): boolean => {
  const added = after - before
  return added >= 0 && added <= SRT_STORE_SIZE
}

/** What a read of one invocation's refused connections found. Same shape as the event's `read`. */
export type RefusedRead =
  | { readonly kind: 'entries'; readonly entries: readonly RefusedEntry[]; readonly complete: boolean }
  | { readonly kind: 'unreadable'; readonly reason: string }

/** Whether the read is worth an event: false only for no entries on a complete read. */
export const worthRecording = (r: RefusedRead): boolean =>
  r.kind === 'unreadable' || r.entries.length > 0 || !r.complete
