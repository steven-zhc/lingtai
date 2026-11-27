/**
 * The run-action helpers the install and build questions share (#397, #1473), and the one sentence the trial's absence
 * prints. Pure, so a list that asks those questions and a command that does call the same code, and the words and the
 * merge are in one place.
 */
import type { Recipe } from '@lingtai/recipe'

export interface NamedRun {
  name: string
  run: string
}

export function isRunAction(value: unknown): value is NamedRun & Record<string, unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { run?: unknown }).run === 'string'
}

/**
 * Said where the answers have a build list and there is no checkout to try it on. Not a prompt: it prints whether or
 * not a terminal is there.
 */
export const NO_CHECKOUT_LINE =
  'the trial run was not run — no checkout on this machine; the first attempt’s `build` is where these first run'

/**
 * The `run:` actions that would actually execute at `step` — the file's own,
 * or inherited from a preset the file `extends:` — or `null` where there is
 * no recipe yet or it does not resolve on its own. A draft's raw key is right
 * for *what to show as a default*; deciding whether an answer changes anything
 * needs this instead, or an answer that only restates what a preset already
 * supplies reads as unchanged and widening later pins the preset's value in anyway.
 *
 * Takes the recipe already resolved (a view's `resolved()`, or `null`), so a caller that holds no path and no text
 * reads the same way: `null` in is `null` out.
 *
 * `null` and `[]` are kept apart on purpose: `[]` is a confirmed "nothing
 * runs here today", and the caller may skip writing a change that would say
 * the same thing. `null` is "unknown" — the file does not exist yet, or does
 * not resolve without an answer this call has not been given (`extends:`
 * written by the same batch, elsewhere in a first-run call) — and the only
 * safe reading of "unknown" is "assume it differs", so the caller always
 * writes its answer explicitly rather than risk a later preset default
 * silently filling in what the person declined.
 */
export function resolvedRunActions(recipe: Recipe | null, step: 'prepared' | 'build'): NamedRun[] | null {
  if (recipe === null) return null
  const actions = recipe.steps[step] as unknown[]
  return actions.filter(isRunAction).map((a) => ({ name: String(a.name ?? ''), run: a.run }))
}

/** A flag that takes its value as a separate following token, e.g. `pnpm --filter web test`. */
const VALUE_FLAGS = /^(?:--filter|-F|--workspace|-w)$/
/**
 * pnpm's own spelling of `-w`/`--workspace`: short for `--workspace-root`, and
 * takes no value at all — unlike npm's `-w`/`--workspace <name>`, which `VALUE_FLAGS`
 * is otherwise right about.
 */
const PNPM_WORKSPACE_ROOT = /^(?:-w|--workspace-root)$/
/** A subcommand that runs an arbitrary following binary rather than naming the check itself. */
const PASSTHROUGH_SUBCOMMAND = /^(?:exec|dlx|x)$/

/**
 * The script a command invokes, when it is `<pm> [run[-script]] <script>`.
 * Walks past a `-F`/`--filter`-style flag's own value and past a passthrough
 * subcommand like `exec`, since either would otherwise be captured in place
 * of the check it actually names — a numbered name where nothing is left.
 */
function nameForCommand(command: string, used: Set<string>): string {
  const m = /^(pnpm|yarn|npm|bun)\s+(?:run(?:-script)?\s+)?(.*)$/.exec(command.trim())
  // A typed command that is no `<manager> <script>` is named by itself: whitespace
  // collapsed, cut to 40 characters with `…`.
  const whole = command.trim().replace(/\s+/g, ' ')
  let base = whole.length > 40 ? `${whole.slice(0, 39)}…` : whole
  if (m) {
    const manager = m[1]
    const tokens = m[2]!.split(/\s+/).filter((t) => t !== '')
    let i = 0
    while (i < tokens.length && tokens[i]!.startsWith('-')) {
      const takesValue = VALUE_FLAGS.test(tokens[i]!) && !(manager === 'pnpm' && PNPM_WORKSPACE_ROOT.test(tokens[i]!))
      i += takesValue ? 2 : 1
    }
    if (i < tokens.length && PASSTHROUGH_SUBCOMMAND.test(tokens[i]!)) i += 1
    const candidate = tokens[i]
    if (candidate !== undefined && /^[\w:.-]+$/.test(candidate)) base = candidate
  }
  // `:` is reserved for the conductor's own actions; the recipe refuses it in a name.
  base = base.replaceAll(':', '-')
  let name = base
  let n = 2
  while (used.has(name)) name = `${base}-${n++}`
  used.add(name)
  return name
}

/**
 * The names `mergeRunActions` keeps from `original` when `wantedRuns` are
 * written: every non-`run:` action's name, and the name of each `run:` entry
 * whose text matches a wanted one. Beside the merge so the two cannot drift.
 */
function keptNames(
  original: unknown[],
  wantedRuns: readonly string[],
): { byRun: Map<string, string>; all: Set<string> } {
  const byRun = new Map<string, string>()
  const all = new Set<string>()
  for (const item of original) {
    const name = (item as { name?: unknown } | null)?.name
    if (typeof name !== 'string') continue
    if (!isRunAction(item)) all.add(name)
    else if (wantedRuns.includes(item.run)) {
      all.add(name)
      if (!byRun.has(item.run)) byRun.set(item.run, name)
    }
  }
  return { byRun, all }
}

export function namedFromTyped(commands: readonly string[], original: unknown[]): NamedRun[] {
  const kept = keptNames(original, commands)
  const used = new Set(kept.all)
  return commands.map((run) => ({ name: kept.byRun.get(run) ?? nameForCommand(run, used), run }))
}

/**
 * `original` with its `run:` entries replaced by `wanted`, in place — every
 * other action keeps its position. A `wanted` entry is matched against
 * `original` by its `run:` text, not by where either sits in its list — an
 * action removed or reordered ahead of it must not make it look unchanged.
 * A match keeps the original's other fields (`timeout`, `env`) too, rather
 * than being rebuilt bare; an entry with no match in `original` is new and
 * gets none.
 */
export function mergeRunActions(original: unknown[], wanted: NamedRun[]): unknown[] {
  const remaining = [...wanted]
  const merged: unknown[] = []
  for (const item of original) {
    if (isRunAction(item)) {
      const i = remaining.findIndex((w) => w.run === item.run)
      if (i === -1) continue
      const [next] = remaining.splice(i, 1)
      merged.push({ ...item, run: next!.run })
    } else {
      merged.push(item)
    }
  }
  merged.push(...remaining)
  return merged
}
