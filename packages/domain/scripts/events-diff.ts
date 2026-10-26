/**
 * What changed between two `events.json` manifests, for a release's notes (#632).
 *
 * The diff and the text are pure functions so a unit test can hold them; the
 * workflow only calls the CLI at the bottom. There is no *renamed* category:
 * nothing in the registry says one event became another, so a rename is a
 * retirement plus an addition and is not guessed from names.
 */
import { readFileSync } from 'node:fs'

import type { EventsDoc } from './events.ts'

export type EventChanges = {
  added: string[]
  retired: string[]
  bumped: { name: string; from: number; to: number }[]
}

/** Added: new, or appendable again. Retired: flagged, or gone outright. Bumped: the payload changed. */
export function diffEvents(old: EventsDoc, next: EventsDoc): EventChanges {
  const before = new Map(old.events.map((e) => [e.name, e]))
  const after = new Map(next.events.map((e) => [e.name, e]))
  const changes: EventChanges = { added: [], retired: [], bumped: [] }
  for (const e of next.events) {
    const was = before.get(e.name)
    if (e.retired) {
      if (was !== undefined && !was.retired) changes.retired.push(e.name)
    } else if (was === undefined || was.retired) {
      changes.added.push(e.name)
    } else if (was.schemaVersion !== e.schemaVersion) {
      changes.bumped.push({ name: e.name, from: was.schemaVersion, to: e.schemaVersion })
    }
  }
  for (const e of old.events) if (!after.has(e.name) && !e.retired) changes.retired.push(e.name)
  return changes
}

export function renderEventsChanged({
  previousTag,
  previous,
  next,
}: {
  previousTag: string | null
  previous: EventsDoc | null
  next: EventsDoc
}): string {
  const head = '## Events changed\n\n'
  if (previous === null) {
    const why = previousTag ? ` (${previousTag} has none)` : ''
    return `${head}First release with an events manifest${why}.\n`
  }
  const c = diffEvents(previous, next)
  const since = previousTag ?? 'the previous release'
  if (c.added.length === 0 && c.retired.length === 0 && c.bumped.length === 0) {
    return `${head}No event changed since ${since}.\n`
  }
  const list = (title: string, items: string[]) =>
    items.length === 0 ? '' : `**${title}**\n\n${items.map((i) => `- ${i}`).join('\n')}\n\n`
  return (
    (
      head +
      list(
        'Added',
        c.added.map((n) => `\`${n}\``),
      ) +
      list(
        'Retired',
        c.retired.map((n) => `\`${n}\``),
      ) +
      list(
        'Schema version bumped (the payload changed)',
        c.bumped.map((b) => `\`${b.name}\` ${b.from} → ${b.to}`),
      )
    ).trimEnd() + '\n'
  )
}

function readDoc(path: string): EventsDoc {
  const doc: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const events = (doc as { events?: unknown } | null)?.events
  if (!Array.isArray(events) || events.some((e) => typeof (e as { name?: unknown })?.name !== 'string')) {
    throw new Error(`${path} is not an events manifest: no \`events\` array of named entries`)
  }
  return doc as EventsDoc
}

if (import.meta.main) {
  // events-diff.ts [<previous events.json>] <next events.json> [<previous tag>]
  // The previous path is given only when the previous release had the asset.
  const args = process.argv.slice(2)
  const paths = args.filter((a) => a.endsWith('.json'))
  const tag = args.find((a) => !a.endsWith('.json')) ?? null
  const next = readDoc(paths.at(-1)!)
  const previous = paths.length > 1 ? readDoc(paths[0]!) : null
  process.stdout.write(renderEventsChanged({ previousTag: tag, previous, next }))
}
