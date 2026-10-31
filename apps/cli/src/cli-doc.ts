import { root } from './cli.ts'
/**
 * `doc/cli.json` and `doc/cli.md`, generated (#545).
 *
 * Two sources, one per field: `COMMANDS` owns the group, the task, the effect,
 * the usage prose and the examples — the same object `--help` is rendered from —
 * and the `@effect/cli` tree behind `root` owns the flags, since in `COMMANDS`
 * they exist only as prose. `cliManifest` joins them into the value `cli.json`
 * holds; `renderCliPage` is a function of that value and nothing else, which is
 * what makes the page render from `cli.json`. Both are pure; `scripts/cli-doc.ts`
 * writes them and `unit/cli-doc.test.ts` fails when the committed files differ.
 *
 * No timestamp, commit or package version goes in either file: a stamp would make
 * the staleness test red on every commit and the release diff noise.
 */
import { COMMANDS, GROUPS, type Group } from './commands.ts'
import { JSON_VERSION } from './output.ts'

export type ManifestCommand = {
  readonly name: string
  readonly group: Group
  readonly task: string
  readonly effect: 'reads' | 'changes'
  readonly usage: readonly string[]
  readonly examples: readonly string[]
  /** Every option the parser takes under this command, verbs included, sorted. */
  readonly flags: readonly string[]
  /** The `--json` document `version`, or null when the command takes no `--json`. */
  readonly json: number | null
}

export type Manifest = { readonly version: 1; readonly commands: readonly ManifestCommand[] }

type Node = Record<string, unknown>
const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null

/**
 * Every option's `fullName` under `node`. Only an `options` subtree is read —
 * an `Args` node carries a `name` too, and walking it would turn `project` into
 * `--project`. This is `@effect/cli` 0.73 internals; `cli-doc.test.ts` pins it.
 */
function optionNames(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) return node.forEach((each) => optionNames(each, into))
  if (!isNode(node)) return
  if (typeof node.fullName === 'string') into.add(`--${node.fullName.replace(/^-+/, '')}`)
  for (const value of Object.values(node)) optionNames(value, into)
}

function walk(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) return node.forEach((each) => walk(each, into))
  if (!isNode(node)) return
  for (const [key, value] of Object.entries(node)) {
    if (key === 'options') optionNames(value, into)
    else if (key !== 'args' && key !== 'description') walk(value, into)
  }
}

/** The flags the parser takes under each top-level command, by command name. */
export function parserFlags(): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, readonly string[]>()
  const children = (root as unknown as { descriptor: { children: readonly unknown[] } }).descriptor.children
  for (const child of children) {
    const names = new Set<string>()
    walk(child, names)
    const name = firstName(child)
    if (name !== undefined) out.set(name, [...names].sort())
  }
  return out
}

/** The name of the first `Standard` under a child — the command itself, even when verbs sit beneath it. */
function firstName(node: unknown): string | undefined {
  if (!isNode(node)) return undefined
  if (node._tag === 'Standard' && typeof node.name === 'string') return node.name
  for (const key of ['command', 'parent']) {
    const found = firstName(node[key])
    if (found !== undefined) return found
  }
  return undefined
}

export function cliManifest(): Manifest {
  const flags = parserFlags()
  const commands = GROUPS.flatMap((group) =>
    COMMANDS.filter((c) => c.group === group).map((c): ManifestCommand => {
      const own = flags.get(c.name) ?? []
      return {
        name: c.name,
        group: c.group,
        task: c.task,
        effect: c.effect,
        usage: c.usage,
        examples: c.examples,
        flags: own,
        json: own.includes('--json') ? JSON_VERSION : null,
      }
    }),
  )
  return { version: 1, commands }
}

export function renderManifest(manifest: Manifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

/** Whether every invocation in `usage` names `--json` — a block is a `lingtai …` line and what is indented beneath it. */
function jsonOnEveryInvocation(usage: readonly string[]): boolean {
  const blocks: string[] = []
  for (const line of usage) {
    if (line.startsWith('lingtai ') || blocks.length === 0) blocks.push(line)
    else blocks[blocks.length - 1] += `\n${line}`
  }
  return blocks.every((block) => block.includes('--json'))
}

function effectLine(c: ManifestCommand): string {
  const lead = c.effect === 'reads' ? 'Reads only' : 'Changes state'
  if (c.json === null) return `${lead}.`
  if (!jsonOnEveryInvocation(c.usage)) {
    return `${lead} — \`--json\` only on the invocations that show it below (version ${c.json}).`
  }
  return c.effect === 'reads'
    ? `${lead} — takes \`--json\` (version ${c.json}).`
    : `${lead} — \`--json\` on its verdict (version ${c.json}).`
}

/** A sentence under a group's table, for what the group's commands have in common. */
const GROUP_NOTES: Partial<Record<Group, string>> = {
  'waiting on you':
    "Except `close`, which also carries out the recipe's end actions on the ticket at once, these commands only append to the log. When a wait ends, the conductor's next action on that ticket (the landing, the next hold, the release or the claim) edits the ticket's \"Lingtai is waiting on you\" comment into its outcome and posts no second comment; the CLI and the board never edit it.",
}

/** The page: a function of the manifest alone. Headings carry no backticks, so the anchor is `lingtai-<name>`. */
export function renderCliPage(manifest: Manifest): string {
  const out: string[] = [
    '# The lingtai command line',
    '',
    'Generated from `apps/cli/src/commands.ts` and the parser; `lingtai --help` prints the same. Do not edit — run `pnpm docs:cli`.',
  ]
  for (const group of GROUPS) {
    const inGroup = manifest.commands.filter((c) => c.group === group)
    out.push('', `## ${capitalise(group)}`, '', '| To… | Run |', '|---|---|')
    for (const c of inGroup) out.push(`| ${c.task} | [lingtai ${c.name}](#lingtai-${c.name}) |`)
    const note = GROUP_NOTES[group]
    if (note !== undefined) out.push('', note)
    for (const c of inGroup) {
      out.push(
        '',
        `### lingtai ${c.name}`,
        '',
        capitalise(c.task) + '.',
        '',
        effectLine(c),
        '',
        '```text',
        ...c.usage,
        '```',
        '',
        '```sh',
        ...c.examples,
        '```',
      )
    }
  }
  return `${out.join('\n')}\n`
}
