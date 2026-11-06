/**
 * The run log's line format, and nothing else.
 *
 * **No `import`, on purpose.** `run-log.ts` imports `node:fs/promises`, and a board
 * client component that reached it would pass `tsc` and `pnpm test` and fail only
 * the Next build (#230). This module is what the browser may read; a unit test
 * asserts it has no `import`.
 */

/**
 * Where the label starts, and how wide it is — `HH:MM:SS` and two spaces.
 *
 * Named because `runLogEnded` is the inverse of `runLogLine` and the two have
 * to agree; a reader that counted the columns for itself would be a second copy
 * of the format, in the one place where being wrong looks like a run that never
 * ends.
 */
export const LABEL_AT = 8 + 2
export const LABEL_WIDTH = 8

/**
 * One line: `14:22:31  Edit    allow  packages/agent/src/claude-code.ts`.
 *
 * Local time and seconds only, because the file is read while it is being
 * written and against a person's own clock; the date is on the header line the
 * file opens with. One line per fact, always — a `Bash` command with a newline
 * in it would otherwise break `tail -f` and every reader after it.
 */
export function runLogLine(at: Date, label: string, detail: string): string {
  const hh = String(at.getHours()).padStart(2, '0')
  const mm = String(at.getMinutes()).padStart(2, '0')
  const ss = String(at.getSeconds()).padStart(2, '0')
  const flat = detail.replace(/\s*\r?\n\s*/g, ' ⏎ ').trimEnd()
  // A label as wide as the column still gets a space after it: a gate's
  // `proposed:review` is twice the width, and run into its detail it would read
  // as one word (#153).
  const column = label.length >= LABEL_WIDTH ? `${label} ` : label.padEnd(LABEL_WIDTH)
  return `${hh}:${mm}:${ss}  ${column}${flat}\n`
}

/**
 * The label on the last line a log ever gets.
 *
 * **The only thing a reader may take from this file's contents** (0034 §8). The
 * file is a trace and never settles anything, so nothing here says how the run
 * *went* — that is `events`, and `lingtai status` is how you ask. What this
 * line settles is narrower and is not about the run at all: **the writer has let
 * go**, so a `tail` may stop waiting. A viewer returning your prompt is not a
 * behaviour of Lingtai's, and §8's test — would some behaviour change with the
 * contents — is about the system, not about when a terminal comes back.
 *
 * It is matched on the *label* and never on the detail. Everything an agent
 * controls arrives as a detail (`traceOf` labels its prose `agent` and its
 * reasoning `think`), so an agent that prints this sentence verbatim writes it
 * into a column where it cannot be mistaken for this line.
 */
export const RUN_LOG_END = 'end'

/**
 * How a follow stopped.
 *
 * `removed` is an ending too, and the same one: 0034 §4 deletes the file when
 * the run landed and §5 when its work item did, so a file that is gone is a
 * file with nothing left to explain.
 */
export type RunLogEnding = 'landed' | 'did not land' | 'removed'

/**
 * The sentence the log closes on, written by whoever took the keep-or-delete.
 *
 * Here rather than at that call site because the reader below is the inverse of
 * it — one module, so the two cannot drift into a `tail` that never returns.
 */
export function runLogEnd(didLand: boolean): string {
  return didLand
    ? 'landed — the diff is on the branch and the events are on the log, so this file goes'
    : 'did not land — this file is kept, and is the only account of why'
}

/** `runLogEnd`'s inverse, and it reads the label column only. See `RUN_LOG_END`. */
export function runLogEnded(line: string): Exclude<RunLogEnding, 'removed'> | null {
  if (line.slice(LABEL_AT, LABEL_AT + LABEL_WIDTH) !== RUN_LOG_END.padEnd(LABEL_WIDTH)) return null
  const detail = line.slice(LABEL_AT + LABEL_WIDTH)
  if (detail.startsWith('landed')) return 'landed'
  if (detail.startsWith('did not land')) return 'did not land'
  return null
}

/**
 * Whether a line is the agent speaking, and if so when and what.
 *
 * `tag` is the tag the run's lines are filed under (`taggedTrace`): null for the
 * implementer's own, whose label column is exactly `agent`. A line that does not
 * parse — another label, another tag, a JSON answer, a clipped line — is not a
 * said line; the safe side is fewer quotes, never a tool call shown as speech.
 */
export function runLogSaid(line: string, tag: string | null): { at: string; text: string } | null {
  const at = line.slice(0, LABEL_AT - 2)
  if (!/^\d\d:\d\d:\d\d$/.test(at)) return null
  let text: string
  if (tag === null) {
    if (line.slice(LABEL_AT, LABEL_AT + LABEL_WIDTH) !== 'agent'.padEnd(LABEL_WIDTH)) return null
    text = line.slice(LABEL_AT + LABEL_WIDTH)
  } else {
    const column = tag.length >= LABEL_WIDTH ? `${tag} ` : tag.padEnd(LABEL_WIDTH)
    if (line.slice(LABEL_AT, LABEL_AT + column.length) !== column) return null
    const rest = line.slice(LABEL_AT + column.length)
    const label = `${'agent'.padEnd(6)}  `
    if (!rest.startsWith(label)) return null
    text = rest.slice(label.length)
  }
  text = text.trim()
  if (text === '' || text.startsWith('{') || text.startsWith('[')) return null
  // A line the adapter clipped ends in its notice (`clip` in claude-code.ts): partial prose is not quoted.
  if (/ … \(\d+ more characters; the transcript has all of it\)$/.test(text)) return null
  return { at, text }
}

/**
 * Whether a line is an action's `started · <kind> on <sha>[ · round N]` line
 * (`action.ts` writes it). It marks where a phase begins; the tag before it holds a
 * `:`, which an adapter's own label never does.
 */
export function runLogStarted(line: string): boolean {
  return runLogStartedTag(line) !== null
}

/** The tag of an action's start line (`review:second`), or null where the line is not one. */
export function runLogStartedTag(line: string): string | null {
  const tagged = line.slice(LABEL_AT).trimEnd()
  if (tagged.startsWith('agent'.padEnd(LABEL_WIDTH))) return null
  const i = tagged.indexOf(' started · ')
  if (i < 0) return null
  const tag = tagged.slice(0, i)
  if (!tag.includes(':')) return null
  return /^started · \S+ on [0-9a-f]{7}( · round \d+)?$/.test(tagged.slice(i + 1)) ? tag : null
}
