import { execFileSync } from 'node:child_process'
import { rename, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'

import { resolveWindow } from '@lingtai/conductor/report'
import { projectionLag, readTicketReport } from '@lingtai/projector'
import { readTasks } from '@lingtai/projector/task-view'

import { BOOKS_FILE } from '../src/lib/books.ts'
import { takeBooks, titleKey } from './take-books.ts'

/**
 * Takes Lingtai's own books for the front page (#811).
 *
 * **Run by the operator at each release, never by a build or CI** — CI cannot
 * read the log (`deploy-site.yml`). It writes one committed file, `books.json`;
 * the site's build reads it. No build step writes or deletes that file, which is
 * the point: `snapshot.ts` deletes `snapshot.json` on every build, on purpose,
 * and this is a different file.
 *
 *     LINGTAI_DATABASE_URL=… LINGTAI_SITE_PUBLIC_PROJECTS=owner/repo \
 *       pnpm --filter @lingtai/site books --from 2026-10-02 --to 2026-10-31 --receipt 640 --receipt 603
 *
 * **It refuses and writes nothing**, rather than a partial file: a read that fails, a projection that is behind or has no
 * checkpoint, a `--receipt` it cannot stand behind. `lingtai report` is the
 * opposite on the lag — it prints anyway and says so on stderr — because there
 * the figures are read by the operator; here they are published.
 *
 * Only public projects are counted at all: a private project's tickets are left
 * out of every figure, not merely untitled.
 */

const REPORT_PROJECTIONS = ['ticket_report', 'task_view']

const DAY = 86_400_000

/** Which projection is behind, as `lingtai report` words it. */
function lagNotes(lags: readonly { name: string; lag: bigint }[]): string[] {
  const notes: string[] = []
  for (const name of REPORT_PROJECTIONS) {
    const row = lags.find((l) => l.name === name)
    if (row === undefined) notes.push(`${name} has no checkpoint yet — figures may be missing`)
    else if (row.lag > 0n) notes.push(`${name} is ${row.lag} events behind the log — figures may be older than it`)
  }
  return notes
}

function publishable(): Set<string> {
  const named = process.env.LINGTAI_SITE_PUBLIC_PROJECTS ?? ''
  return new Set(
    named
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p !== ''),
  )
}

function head(): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

/** A local calendar day from `YYYY-MM-DD`, or null. */
function day(s: string | undefined): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? '')
  if (m === null) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return d.getMonth() === Number(m[2]) - 1 ? d : null
}

function refuse(lines: string[]): never {
  for (const l of lines) console.error(`books: ${l}`)
  console.error('books: nothing was written.')
  process.exit(1)
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { from: { type: 'string' }, to: { type: 'string' }, receipt: { type: 'string', multiple: true } },
  })
  const from = day(values.from)
  const to = day(values.to)
  if (from === null || to === null || values.from === undefined || values.to === undefined) {
    refuse(['--from and --to are required, as YYYY-MM-DD.'])
  }
  const receipts = values.receipt ?? []
  const badReceipt = receipts.filter((n) => !/^\d+$/.test(n))
  if (badReceipt.length > 0) refuse([`--receipt takes an issue number, not ${badReceipt.join(', ')}.`])

  // No URL is required: with none, the store is the machine's chosen one
  // (`config.yml`, SQLite or Postgres), as `lingtai report` reads it. An exported
  // URL selects Postgres, overriding a configured SQLite store: leave it
  // unexported to read the configured one.
  const exported = process.env.LINGTAI_DATABASE_URL
  const url = exported === undefined || exported === '' ? undefined : exported

  const open = publishable()
  if (open.size === 0) refuse(['LINGTAI_SITE_PUBLIC_PROJECTS names no project, so there is nothing to publish.'])

  const now = new Date()
  if (from.getTime() > to.getTime()) refuse([`--from ${values.from} is after --to ${values.to}`])
  const window = resolveWindow({ from, to }, now)

  try {
    const notes = lagNotes(await projectionLag(url))
    if (notes.length > 0) refuse(notes)

    const rows = await readTicketReport({ url })
    // `readTasks` hides a card closed longer ago than its retention, 2 days by
    // default: a receipt from the start of the window would come back untitled.
    const retentionDays = Math.ceil((now.getTime() - window.from.getTime()) / DAY) + 1
    const tasks = await readTasks({ url, retentionDays })
    const titles = new Map(tasks.map((t) => [titleKey(t.project, t.issue), t.title] as const))

    // One lag check, before the reads, is the whole rule. A projection rebuilt
    // while this reads is not guarded, on purpose (#811): a person runs this once
    // per release on a quiet system and reads the file before committing it.
    const taken = takeBooks(rows, {
      from: values.from,
      to: values.to,
      window,
      capturedAt: now,
      commit: head(),
      open,
      receipts,
      titles,
    })
    if (!taken.ok) refuse(taken.refusals)

    const n = taken.books.outcomes.landed + taken.books.outcomes.closed + taken.books.outcomes.open
    if (n === 0) console.log('books: 0 public tickets in the window')

    // Whole or not at all: a crash halfway leaves the last release's books.
    const tmp = `${BOOKS_FILE}.tmp`
    await writeFile(tmp, `${JSON.stringify(taken.books, null, 2)}\n`)
    await rename(tmp, BOOKS_FILE)
    console.log(
      `books: ${taken.books.outcomes.landed} landed, ${taken.books.outcomes.closed} closed, ${taken.books.outcomes.open} open, ${taken.books.receipts.length} receipts → ${BOOKS_FILE}`,
    )
  } catch (err) {
    refuse([`the log could not be read: ${err instanceof Error ? err.message : String(err)}`])
  }
}

await main()
