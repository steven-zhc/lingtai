/**
 * What changed between two `cli.json` manifests, for a release's notes (#634).
 *
 * The diff and the text are pure functions so a unit test can hold them; the
 * workflow only calls the CLI at the bottom. Only what a script can depend on is
 * compared — the command set, each command's flags, its `--json` version and
 * whether it reads or changes; the group, task, usage and examples are prose.
 * `Manifest` is a type-only import: `cli-doc.ts` imports the whole CLI.
 */
import { readFileSync } from 'node:fs'

import type { Manifest } from './cli-doc.ts'

export type CommandChange = {
  name: string
  flagsAdded: string[]
  flagsRemoved: string[]
  /** Both sides take `--json` and the document version differs. */
  json: { from: number; to: number } | null
  effect: { from: 'reads' | 'changes'; to: 'reads' | 'changes' } | null
}

export type CliChanges = {
  added: string[]
  removed: string[]
  changed: CommandChange[]
}

/** Added and changed in `next`'s order, then removed in `old`'s. */
export function diffCli(old: Manifest, next: Manifest): CliChanges {
  const before = new Map(old.commands.map((c) => [c.name, c]))
  const after = new Set(next.commands.map((c) => c.name))
  const out: CliChanges = { added: [], removed: [], changed: [] }
  for (const c of next.commands) {
    const was = before.get(c.name)
    if (was === undefined) {
      out.added.push(c.name)
      continue
    }
    const had = new Set(was.flags)
    const has = new Set(c.flags)
    const change: CommandChange = {
      name: c.name,
      flagsAdded: c.flags.filter((f) => !had.has(f)),
      flagsRemoved: was.flags.filter((f) => !has.has(f)),
      // null → n and n → null are the `--json` flag appearing or going; the flag lines say so.
      json: was.json !== null && c.json !== null && was.json !== c.json ? { from: was.json, to: c.json } : null,
      effect: was.effect !== c.effect ? { from: was.effect, to: c.effect } : null,
    }
    if (change.flagsAdded.length || change.flagsRemoved.length || change.json || change.effect) {
      out.changed.push(change)
    }
  }
  for (const c of old.commands) if (!after.has(c.name)) out.removed.push(c.name)
  return out
}

function describe(c: CommandChange): string {
  const parts = [
    ...c.flagsAdded.map((f) => `\`${f}\` added`),
    ...c.flagsRemoved.map((f) => `\`${f}\` removed`),
    ...(c.json ? [`\`--json\` ${c.json.from} → ${c.json.to}`] : []),
    ...(c.effect ? [`now ${c.effect.to === 'changes' ? 'changes state' : 'only reads'}`] : []),
  ]
  return `\`${c.name}\`: ${parts.join(', ')}`
}

export function renderCliChanged({
  previousTag,
  previous,
  next,
}: {
  previousTag: string | null
  previous: Manifest | null
  next: Manifest
}): string {
  const head = '## CLI changed\n\n'
  if (previous === null) {
    const why = previousTag ? ` (${previousTag} has none)` : ''
    return `${head}First release with a CLI manifest${why}.\n`
  }
  const c = diffCli(previous, next)
  const since = previousTag ?? 'the previous release'
  if (c.added.length === 0 && c.removed.length === 0 && c.changed.length === 0) {
    return `${head}No command, flag or \`--json\` version changed since ${since}.\n`
  }
  const list = (title: string, items: string[]) =>
    items.length === 0 ? '' : `**${title}**\n\n${items.map((i) => `- ${i}`).join('\n')}\n\n`
  return (
    (
      head +
      list(
        'Commands added',
        c.added.map((n) => `\`${n}\``),
      ) +
      list(
        'Commands removed',
        c.removed.map((n) => `\`${n}\``),
      ) +
      list('Commands changed', c.changed.map(describe))
    ).trimEnd() + '\n'
  )
}

/** Refuses anything but the one shape `Manifest` admits, so a format change turns the step red. */
export function parseManifest(text: string, path = 'manifest'): Manifest {
  const doc: unknown = JSON.parse(text)
  const o = doc as { version?: unknown; commands?: unknown } | null
  if (o === null || typeof o !== 'object' || o.version !== 1) {
    throw new Error(`${path} is not a version 1 CLI manifest`)
  }
  const commands = o.commands
  if (!Array.isArray(commands) || commands.some((c) => typeof c?.name !== 'string' || !Array.isArray(c.flags))) {
    throw new Error(`${path} is not a CLI manifest: no \`commands\` array of named entries with flags`)
  }
  return doc as Manifest
}

if (import.meta.main) {
  // cli-diff.ts [<previous cli.json>] <next cli.json> [<previous tag>]
  // The previous path is given only when the previous release had the file.
  const args = process.argv.slice(2)
  const paths = args.filter((a) => a.endsWith('.json'))
  const tag = args.find((a) => !a.endsWith('.json')) ?? null
  const read = (p: string) => parseManifest(readFileSync(p, 'utf8'), p)
  const next = read(paths.at(-1)!)
  const previous = paths.length > 1 ? read(paths[0]!) : null
  process.stdout.write(renderCliChanged({ previousTag: tag, previous, next }))
}
