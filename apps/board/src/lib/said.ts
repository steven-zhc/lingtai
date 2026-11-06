/**
 * What the agent said last, from the run log's lines.
 *
 * The board's rule over the log's format (`run-log-format.ts`): three lines, newest
 * first, and never past the start of the phase they are about. **Imports the
 * format module and not `run-log.ts`**, which reaches `node:fs` (#230).
 *
 * The run log is a trace (0111 §13): nothing is decided from what this returns.
 */
import { runLogSaid, runLogStarted } from '@lingtai/agent/run-log-format'

export const SAID_LINES = 3

export interface Said {
  at: string
  text: string
}

/**
 * The newest `n` said lines of the phase in flight. Scans newest to oldest and
 * stops at the first `started ·` line of any tag: it is either this phase's own
 * start, or a later phase's — and either way nothing older belongs to this round,
 * which needs no round arithmetic.
 */
export function saidLast(lines: readonly string[], tags: readonly (string | null)[], n = SAID_LINES): Said[] {
  const out: Said[] = []
  if (tags.length === 0) return out
  for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
    const line = lines[i]!
    if (runLogStarted(line)) break
    for (const tag of tags) {
      const said = runLogSaid(line, tag)
      if (said !== null) {
        out.push(said)
        break
      }
    }
  }
  return out
}

/**
 * Whether the scan ran off the top of the lines held without meeting a phase
 * start — so an empty answer is *not in the last N lines* rather than *not yet*.
 */
export function scannedAll(lines: readonly string[], held: number): boolean {
  return lines.length >= held && !lines.some(runLogStarted)
}

/** Whether the tail is followed: while the run is live, or when the reader opened the log. */
export function tailRule(live: boolean, open: boolean): boolean {
  return live || open
}

/** Open is the reader's, and about one run: a different run starts closed. */
export function openFor(opened: string | null, shown: string | null): boolean {
  return shown !== null && opened === shown
}
