/**
 * A project's recipe, read from this machine: `~/.lingtai/<project>/recipe.yml` and the machine file beside it
 * (0128 §8). Everything that is a function of the text stays in `@lingtai/recipe`; this is the read.
 */
import { RuntimeId } from '@lingtai/domain'
import { stateDir } from '@lingtai/env'
import {
  AgentUnresolvedError,
  LIMIT_DEFAULTS,
  PROVENANCE_ARROW,
  type RecipeFailed,
  RecipeMissingError,
  type SandboxHostOptions,
  type SignedIn,
  SCHEMA_PROBE_AGENT,
  asRecord,
  assigneeOf,
  backoffOf,
  branchOf,
  ceilingOf,
  checkMachineConfig,
  checkSandboxBlock,
  excludeOf,
  failed,
  isRefusal,
  kindsOf,
  machineFileIn,
  namedIn,
  originIn,
  plainWhen,
  recipeFileIn,
  resolveAgent,
  resolveSource,
  selectionOf,
} from '@lingtai/recipe'
import { Effect } from 'effect'

import { readRecipeFile } from './files.ts'

/** A project's recipe, under `stateDir()`. */
export function recipePath(project: string, home: string = stateDir()): string {
  return recipeFileIn(home, project)
}

/** This machine's own settings, under `stateDir()`. */
export function machinePath(home: string = stateDir()): string {
  return machineFileIn(home)
}

export interface LocalRecipeOptions extends SandboxHostOptions {
  /** `stateDir()` unless a test says otherwise. */
  home?: string
  /** Asked only when the recipe names no `runtime.agent`. */
  signedIn: SignedIn
  /**
   * The branch this project was registered against, which becomes `ref`. The
   * file has no branch of its own, so the recipe's `branch.main` stands in when
   * nothing was recorded. It is printed and nothing decides from it: the
   * landing branch is `branchOf(recipe)`.
   */
  base?: string | null
  /** Reads a file; null when it is not there. */
  read?: (path: string) => Promise<string | null>
}

/**
 * The recipe governing this project's next run, from this machine.
 *
 * Fails, like `resolveRecipe`, for the same reason: every caller's correct
 * response to an unreadable recipe is to stop. `read` is the Effect-side reader
 * a caller inside the package may hand in; it wins over `options.read`.
 */
export const resolveLocalRecipeEffect = Effect.fn('recipe.resolve-local')(function* (
  project: string,
  options: LocalRecipeOptions,
  readWith?: (path: string) => Effect.Effect<string | null, RecipeFailed>,
) {
  const home = options.home ?? stateDir()
  const optionRead = options.read
  const read =
    readWith ??
    (optionRead === undefined
      ? readRecipeFile
      : (p: string): Effect.Effect<string | null, RecipeFailed> =>
          Effect.tryPromise({ try: () => optionRead(p), catch: failed('read') }))
  const path = recipePath(project, home)
  const machineFile = machinePath(home)

  const source = yield* read(path)
  if (source === null) {
    return yield* Effect.fail(
      new RecipeMissingError(
        options.base ?? path,
        `no recipe at ${path}. The recipe is yours and lives on this machine (0046 §3) — ` +
          'nothing is read from the repository, and nothing needs committing to it',
      ),
    )
  }

  // Read for its refusals: the machine file names nothing a resolve uses.
  const machine = yield* read(machineFile)
  yield* plainWhen(() => checkMachineConfig(machine, machineFile, project, home), isRefusal)

  // The recipe's own `runtime.agent`, read off the file before anything is
  // merged: a preset carries none (it is about commands, not preference), and
  // the schema's default must never stand in for a choice nobody wrote down.
  const written = yield* plainWhen(() => namedIn(source, path), isRefusal)
  // A value written that is not a runtime is kept for the schema to refuse by
  // path — never replaced by what happens to be signed in.
  let agent: { agent: RuntimeId; from: string } | null = null
  if (written !== 'not a runtime') {
    agent = yield* resolveAgent(written, options.signedIn, path).pipe(
      // **The recipe's own fault first.** A file that is wrong for some other
      // reason is reported as that, not as a missing agent: resolved once with
      // a placeholder so the schema speaks, and only a file that passes is
      // refused for its agent. Anything else (a signed-in probe that rejected)
      // passes through without the probe.
      Effect.catchIf(
        (e): e is AgentUnresolvedError => e instanceof AgentUnresolvedError,
        (err) =>
          plainWhen(
            () =>
              resolveSource(source, options.base ?? path, path, (raw) => {
                raw['runtime'] = { ...asRecord(raw['runtime']), agent: SCHEMA_PROBE_AGENT }
                return []
              }),
            isRefusal,
          ).pipe(Effect.andThen(Effect.fail(err))),
      ),
    )
  }

  const provenance: Record<string, string> = {}

  // What the *file itself* carries, kept before anything is merged into it.
  // This is the only place the difference survives: `recipe.source.exclude`
  // reads `[]` and `recipe.steps.proposed` reads the preset's action whether
  // this file mentions either or not, so nothing downstream can tell a value
  // this file decided from one it was silent about (#218).
  //
  // A copy, and not the object: the callback below sets `raw.runtime.agent`
  // to the detected runtime where the file names none, and the preset merges
  // underneath afterwards.
  let wrote: unknown = {}

  const resolved = yield* plainWhen(
    () =>
      resolveSource(source, options.base ?? path, path, (raw) => {
        wrote = structuredClone(raw)
        const own = asRecord(raw['runtime']) ?? {}
        if (agent !== null && !('agent' in own)) raw['runtime'] = { ...own, agent: agent.agent }
        return []
      }),
    isRefusal,
  )

  // What stays the repository's facts, from the recipe file — said with its
  // value, so the doctor prints the resolved recipe rather than a list of names.
  const { recipe } = resolved
  // What the text alone could not decide: a path against this host's protected roots, and a required sandbox
  // against what this host can provide (#1147). A refusal like any recipe in error, so it is per project.
  yield* checkSandboxBlock(recipe, project, options.base ?? path, path, options)
  const from = originIn(wrote, resolved.preset, path)
  // The recipe's own, or the one runtime signed in — and which, said. Only a
  // value the schema refused leaves `agent` null, and that threw above.
  provenance['runtime.agent'] = `${recipe.runtime.agent}${PROVENANCE_ARROW}${agent?.from ?? path}`

  // `limits` is the recipe's own now (`#375`): read off the resolved recipe
  // through `ceilingOf`, named by `originIn` exactly as every other recipe
  // fact is, kept immediately after `runtime.agent` so a reading's row order
  // does not move.
  const ceiling = ceilingOf(recipe)
  for (const group of Object.keys(LIMIT_DEFAULTS) as (keyof typeof LIMIT_DEFAULTS)[]) {
    for (const key of Object.keys(LIMIT_DEFAULTS[group])) {
      const path = `runtime.limits.${group}.${key}`
      const value = (ceiling[group] as Record<string, unknown>)[key]
      provenance[path] = `${value}${PROVENANCE_ARROW}${from(path)}`
    }
  }
  // `usd` has no entry in `LIMIT_DEFAULTS` — it has no default to fall back to
  // (recipe.ts), so the loop above never sees it as a key. Read explicitly, and
  // absent reads as "(none)", never as a vanished key.
  const limitsUsd = ceiling.run.usd
  provenance['runtime.limits.run.usd'] =
    `${limitsUsd ?? '(none)'}${PROVENANCE_ARROW}${limitsUsd === undefined ? 'default' : from('runtime.limits.run.usd')}`

  // **Each step's runtime, off the recipe alone** (`#372`): the runtimes its
  // own `agent:` actions name, and for `implement` — which dispatches whether
  // or not it declares an agent — `runtime.agent` when it names none.
  for (const [step, actions] of Object.entries(recipe.steps)) {
    const named = actions.flatMap((action) =>
      'agent' in action && typeof action.agent === 'string' ? [action.agent] : [],
    )
    if (named.length > 0) {
      provenance[`steps.${step}.agent`] = `${[...new Set(named)].join(', ')}${PROVENANCE_ARROW}${from(`steps.${step}`)}`
    } else if (step === 'implement') {
      provenance['steps.implement.agent'] = `${recipe.runtime.agent}${PROVENANCE_ARROW}runtime.agent`
    }
  }

  const list = (items: readonly string[]) => (items.length > 0 ? items.join(', ') : '(none)')
  const recipeValues: Record<string, string> = {
    'branch.main': recipe.branch.main,
    ...(recipe.branch.personal === undefined ? {} : { 'branch.personal': recipe.branch.personal }),
    'source.kinds': kindsOf(recipe).join(' > '),
    'source.exclude': list(excludeOf(recipe)),
    // Said out loud by a reading, and not carried here until now — so that
    // every row of one has a source beside it (#218).
    'source.backoff': backoffOf(recipe),
    'env.required': list(recipe.env.required),
    steps: Object.entries(recipe.steps)
      .map(([step, actions]) => `${step} ${actions.length}`)
      .join(', '),
  }
  // Per field, as `runtime.limits` is: a recipe that sets `attempts` and
  // nothing else must not put this file's name against the three numbers it
  // does not contain.
  for (const [key, value] of Object.entries(recipe.runtime.budget)) {
    recipeValues[`runtime.budget.${key}`] = String(value)
  }
  // Beside `runtime.budget`: a discussion's own agent and spend, not asked of
  // the file until #243 gave `discuss:` a place to be written (0061 §6).
  recipeValues['discuss.agent'] = recipe.discuss.agent
  recipeValues['discuss.model'] = recipe.discuss.model ?? '(none)'
  recipeValues['discuss.limits.turns'] = String(recipe.discuss.limits.turns)
  recipeValues['discuss.limits.wall'] = recipe.discuss.limits.wall
  // `triage:` is optional with no default (recipe.ts), unlike `discuss:` —
  // absent means nothing runs, and that is a fact worth a row of its own
  // rather than five rows reading as though the schema had defaulted them.
  if (recipe.triage === undefined) {
    recipeValues['triage'] = '(not declared)'
  } else {
    recipeValues['triage.agent'] = recipe.triage.agent
    recipeValues['triage.tools'] = recipe.triage.tools
    recipeValues['triage.model'] = recipe.triage.model ?? '(none)'
    recipeValues['triage.limits.turns'] = String(recipe.triage.limits.turns)
    recipeValues['triage.limits.wall'] = recipe.triage.limits.wall
    recipeValues['triage.limits.usd'] = String(recipe.triage.limits.usd)
  }
  for (const [key, value] of Object.entries(recipeValues)) provenance[key] = `${value}${PROVENANCE_ARROW}${from(key)}`

  // `assignee` is the recipe's now (`#373`), under either spelling — read
  // only once the recipe has resolved, because which spelling it used is a
  // fact `originIn` only has an answer for afterwards. A `claim` `queue:`
  // that names it is the source for both halves, whichever one it wrote;
  // otherwise each half asks `source.assignee.<key>` on its own, so a file
  // that wrote only `login` still reads `take: all ← default`.
  const rule = assigneeOf(recipe)
  const atStep = recipe.steps.claim.some((action) => 'queue' in action) ? from('steps.claim') : null
  provenance['source.assignee.take'] =
    `${selectionOf(recipe).mode === 'team' ? 'mine' : (rule?.take ?? 'all')}${PROVENANCE_ARROW}${atStep ?? from('source.assignee.take')}`
  provenance['source.assignee.login'] =
    `${rule?.login ?? '(none)'}${PROVENANCE_ARROW}${atStep ?? from('source.assignee.login')}`

  return { ...resolved, ref: options.base ?? branchOf(resolved.recipe), provenance }
})
