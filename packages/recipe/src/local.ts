/**
 * The recipe is mine: `~/.lingtai/<project>/recipe.yml`
 * ([0046](../../../doc/decisions-archive/0046-lingtai-is-personal.md) §3), with
 * `~/.lingtai/config.yml` beside it holding the machine's own facts and nothing
 * about how a project's work is run.
 *
 * **The recipe answers every question about a run.** Which runtime a step uses
 * is `agent:` on that step, or `runtime.agent` beside `steps:` for the steps that
 * name none (`#372`); whose tickets a project takes is `runtime.assignee`
 * (`#373`); what a pass may spend is `runtime.limits` (`#375`). Both files sit
 * on one machine, so a machine-wide default under a per-project file answered
 * nothing a person could read off the recipe.
 *
 * **What the machine still answers is which runtimes are signed in** — a fact,
 * detected rather than declared (`resolveAgent`): a recipe that names no agent
 * gets the one runtime signed in, and with several or none it is refused by
 * name. A choice nobody wrote down is the default 0046 §3 is against.
 *
 * Nothing here makes a request. The files are read on every resolve, so an edit
 * reaches the next run and a daemon holds nothing stale.
 *
 * **Both files refuse what belongs in the other, by name.** A key silently
 * dropped and a key that does not exist are different facts to whoever wrote
 * it (0016 §4), and `steps` in the machine file is the one that matters: a step
 * that reads as declared and holds nothing is a way to weaken a gate quietly.
 */
import { join } from 'node:path'

import { RuntimeId } from '@lingtai/domain'
import { Effect } from 'effect'
import { parse as parseYaml } from 'yaml'

import { type RecipeFailed, failed } from './files.ts'
import { PRESETS } from './presets.ts'
import { RecipeInvalidError, RecipeMissingError } from './resolve.ts'

/** A project's recipe file under `home` — a path, never a read; `@lingtai/project`'s `recipePath` defaults the home. */
export function recipeFileIn(home: string, project: string): string {
  return join(home, project, 'recipe.yml')
}

/** The machine's own settings file under `home`. */
export function machineFileIn(home: string): string {
  return join(home, 'config.yml')
}

/** A YAML value as a mapping, or null where it is not one. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * A runtime the schema accepts, written in only to let it report everything
 * else wrong with a recipe that names no agent — **never a choice**: the
 * resolve that uses it rethrows the missing agent once the schema has spoken.
 */
export const SCHEMA_PROBE_AGENT: RuntimeId = 'claude-code'

/** Which runtimes are signed in on this machine. Asked only when the recipe names none. */
export type SignedIn = () => Promise<readonly RuntimeId[]>

export class MachineConfigInvalidError extends Error {
  override readonly name = 'MachineConfigInvalidError'
  readonly problems: readonly string[]

  constructor(path: string, problems: readonly string[]) {
    super(`${path} is not valid:\n  ${problems.join('\n  ')}`)
    this.problems = problems
  }
}

/** The runtime could not be decided without guessing. */
export class AgentUnresolvedError extends Error {
  override readonly name = 'AgentUnresolvedError'
}

/** The four errors a caller decides on by class: a failure, where anything else thrown is a bug. */
export type Refusal = RecipeInvalidError | RecipeMissingError | MachineConfigInvalidError | AgentUnresolvedError

export const isRefusal = (e: unknown): e is Refusal =>
  e instanceof RecipeInvalidError ||
  e instanceof RecipeMissingError ||
  e instanceof MachineConfigInvalidError ||
  e instanceof AgentUnresolvedError

/**
 * **The live name, and only it, since `#247`.**
 *
 * `steps:` is where a pass is configured, and a block under it here is a person
 * who has put it in the wrong file — silently dropped without this, which is
 * 0016 §4's failure and the one this whole file exists to keep out. The
 * pre-0061 spelling was refused beside it until the log's vocabulary went; what
 * it was for was somebody copying an old block across, and it is one of the
 * four retired words, so it could not stay in `src/` and leave
 * `doc/reference.md`'s allowlist empty. A recipe under `version: 1` is still
 * refused by name, and by the version rather than by the key.
 */
function stepsRefusal(at: string, project: string, home: string): string {
  return (
    `${at}: an attempt is not configured in the machine file — it is configured in the recipe, ` +
    `${recipeFileIn(home, project)}, under \`steps:\`. Nothing here was applied; ` +
    'move the block there if it is meant to run'
  )
}

/**
 * **Since `#372`, `#373` and `#375`.** How a project's work is run — which
 * runtime, whose tickets, what a pass may spend — is the recipe's, so a
 * `runtime:` or a `projects:` section here is a person who has not heard of
 * the move, and a key accepted here but never read is exactly what
 * `stepsRefusal` exists to keep this file from doing silently.
 */
function runtimeRefusal(at: string, project: string, home: string): string {
  return (
    `${at}: how a project's work is run is not configured in the machine file — it is configured in the ` +
    `recipe, ${recipeFileIn(home, project)}: \`runtime.agent\` (or \`agent:\` on a step), \`runtime.assignee\` ` +
    'and `runtime.limits`. Nothing here was applied; move it there if it is meant to apply'
  )
}

/**
 * Reads the machine file for its refusals, and nothing else: no key in it is
 * this reader's (`#372`). `null` is a machine with no file, which refuses
 * nothing.
 *
 * Not strict at the top: the file is the machine's (the log, the App, the
 * board's port — `@lingtai/env`), and a section some other reader owns is not
 * this reader's to refuse. **`runtime` and `projects` are refused whole**:
 * every key they ever held moved to the recipe (`#372`, `#373`, `#375`), and a
 * key accepted here but never read is 0016 §4's failure under a new name.
 * `steps` is refused because its silent absence weakens a gate.
 */
export function checkMachineConfig(text: string | null, path: string, project: string, home: string): void {
  if (text === null) return
  let raw: unknown
  try {
    raw = parseYaml(text)
  } catch (err) {
    throw new MachineConfigInvalidError(path, [`could not be parsed as YAML: ${(err as Error).message}`])
  }
  if (raw === null || raw === undefined) return
  const top = asRecord(raw)
  if (top === null) throw new MachineConfigInvalidError(path, ['(root): expected a mapping'])

  const problems: string[] = []
  if ('steps' in top) problems.push(stepsRefusal('steps', project, home))
  if ('runtime' in top) problems.push(runtimeRefusal('runtime', project, home))
  if ('projects' in top) {
    const projects = asRecord(top['projects'])
    if (projects === null) problems.push(runtimeRefusal('projects', project, home))
    for (const [name, scope] of Object.entries(projects ?? {})) {
      const scoped = asRecord(scope) ?? {}
      if ('steps' in scoped) problems.push(stepsRefusal(`projects.${name}.steps`, name, home))
      // Every other key a project's section can hold is a run's, so the
      // section is named whole — beside its `steps` when it has both.
      if (!('steps' in scoped) || Object.keys(scoped).length > 1) {
        problems.push(runtimeRefusal(`projects.${name}`, name, home))
      }
    }
  }
  if (problems.length > 0) throw new MachineConfigInvalidError(path, problems)
}

/**
 * Which agent, and why that one.
 *
 * ```
 * the recipe names one            →  that one
 * absent, exactly one signed in   →  that one
 * absent, more than one           →  say so and ask; never pick silently
 * absent, none                    →  refuse by name
 * ```
 *
 * Detected is a default, not a replacement for being told: the refusal for
 * two says exactly what to write, so the answer is then written down.
 */
export const resolveAgent = (
  named: { agent: RuntimeId; from: string } | null,
  signedIn: SignedIn,
  path: string,
): Effect.Effect<{ agent: RuntimeId; from: string }, RecipeFailed | AgentUnresolvedError> =>
  Effect.gen(function* () {
    if (named) return named
    const detected = [...new Set(yield* Effect.tryPromise({ try: () => signedIn(), catch: failed('signed-in') }))]
    if (detected.length === 1) return { agent: detected[0]!, from: 'detected — the only runtime signed in' }
    if (detected.length > 1) {
      return yield* Effect.fail(
        new AgentUnresolvedError(
          `${detected.join(' and ')} are all signed in on this machine, and ${path} names no runtime.agent — ` +
            `which one should run? Write \`runtime:\\n  agent: <${detected.join('|')}>\` in ${path} — the attempt's own ` +
            "runtime, which a step's `agent:` overrides but does not replace; Lingtai does not pick one silently",
        ),
      )
    }
    return yield* Effect.fail(
      new AgentUnresolvedError(
        `no agent runtime is signed in on this machine, and ${path} names no runtime.agent — ` +
          "`lingtai doctor`'s `runtime: signed in` says what is missing",
      ),
    )
  })

/**
 * How a provenance entry joins its value to where the value came from.
 *
 * Written once because two readers now split on it: `lingtai doctor` prints the
 * whole entry, and the board's recipe page prints the two halves in two columns
 * (#218). A separator spelled out in both places is one nobody can change.
 */
export const PROVENANCE_ARROW = ' ← '

/**
 * The `where` half of a provenance entry — `value ← where` — or null when the
 * entry says nothing about where it came from.
 *
 * Null rather than the whole entry: a reader that cannot find the source must
 * say it has none, not print the value a second time under a heading claiming
 * to be its origin.
 */
export function provenanceSource(entry: string | undefined): string | null {
  if (entry === undefined) return null
  const at = entry.indexOf(PROVENANCE_ARROW)
  return at === -1 ? null : entry.slice(at + PROVENANCE_ARROW.length)
}

/**
 * Whether an object carries a dotted path at all — not what it says there.
 *
 * **A key with nothing under it carries nothing**, and that is `applyPreset`'s
 * rule rather than a convenience here: `recipe["steps"] ?? preset.steps` takes
 * the preset's for a `null` exactly as it does for an absent key, so a
 * `steps:` whose block has been commented out is a file that decided nothing
 * and must not be named as the source of what the preset decided (#218). The
 * intermediate segments have always read it this way; only the leaf did not.
 */
function carries(value: unknown, path: string): boolean {
  let at = value
  for (const segment of path.split('.')) {
    if (at === null || typeof at !== 'object' || Array.isArray(at)) return false
    if (!(segment in (at as Record<string, unknown>))) return false
    at = (at as Record<string, unknown>)[segment]
  }
  return at !== undefined && at !== null
}

/**
 * Where a value in the resolved recipe came from: the file, the preset
 * underneath it, or the schema (#218).
 *
 * **Three origins and not two.** Every key here but `branch.main`, `source.kinds`
 * and `env.plantAt` has a schema default, and `steps` — the most consequential
 * of them, since it is what holds a run — can also come from a preset. A
 * resolved recipe reads the same in all three cases, so a reader told
 * `recipe.yml` for a `steps:` block that file does not contain opens it, finds
 * nothing, and cannot learn the answer anywhere: `extends: pnpm-workspace` is
 * a line about steps that never names them.
 *
 * **Asked at the level the merge happens at**, which is `applyPreset`'s rule
 * and not this function's invention: `repo` and `runtime` merge a key at a
 * time and `steps` replaces whole, so whichever of the two carries
 * `runtime.budget` decides every number in it and the other's is not applied.
 * Hence the section — the first two segments — settles *who*, and only then
 * does the leaf inside it settle file-or-default.
 */
export function originIn(wrote: unknown, preset: string | null, path: string): (key: string) => string {
  return (key) => {
    const section = key.split('.').slice(0, 2).join('.')
    const carrier = carries(wrote, section)
      ? { at: path, held: wrote }
      : preset !== null && carries(PRESETS[preset], section)
        ? { at: `preset ${preset}`, held: PRESETS[preset] }
        : null
    if (carrier === null) return 'default'
    return section === key || carries(carrier.held, key) ? carrier.at : 'default'
  }
}

/**
 * What a recipe's text writes at `runtime.agent`, before any preset or
 * default: `absent`, a runtime, or `not a runtime`. A file that will not parse
 * is `absent` here and left to `resolveSource`, which says so.
 *
 * Exported because the board's edit page asks the same question of the file
 * it is about to change, and a second parser for it is a second answer.
 */
export function writtenAgent(text: string): RuntimeId | 'absent' | 'not a runtime' {
  let raw: unknown
  try {
    raw = parseYaml(text)
  } catch {
    return 'absent'
  }
  const runtime = asRecord(asRecord(raw)?.['runtime'])
  if (runtime === null || !('agent' in runtime)) return 'absent'
  const agent = RuntimeId.safeParse(runtime['agent'])
  return agent.success ? agent.data : 'not a runtime'
}

/** `writtenAgent` as `resolveAgent` takes it. */
export function namedIn(source: string, path: string): { agent: RuntimeId; from: string } | 'not a runtime' | null {
  const written = writtenAgent(source)
  return written === 'absent' ? null : written === 'not a runtime' ? written : { agent: written, from: path }
}
