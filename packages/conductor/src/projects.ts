import { type Runtime, everyRuntime } from '@lingtai/agent'
import { runnableEnv } from '@lingtai/agent-env'
import type { ProjectState, RuntimeId } from '@lingtai/domain'
import { copilotGithubToken } from '@lingtai/env'
import { type LoadProjectOptions, loadProject } from '@lingtai/project'
import { type HostAnswer, type HostFactsEffect, type ResolvedRecipe, type SignedIn } from '@lingtai/recipe'
import { BUILT_IN_DOMAINS, hostProgramsPresent, installFor } from '@lingtai/sandbox'
import { readHost } from '@lingtai/sandbox/host'
import { Effect, Redacted } from 'effect'

export function signedInIdsEffect(
  runtimes: readonly Pick<Runtime, 'capabilities' | 'checkAuth'>[],
  env: Record<string, string>,
): Effect.Effect<readonly RuntimeId[]> {
  return Effect.forEach(
    runtimes,
    (r) =>
      Effect.promise(() => Promise.resolve(r.checkAuth?.(env))).pipe(
        Effect.map((auth) => (auth?.loggedIn ? [r.capabilities.id] : [])),
      ),
    { concurrency: 'unbounded' },
  ).pipe(Effect.map((found) => found.flat()))
}

/**
 * Which runtimes are signed in here, in the environment a run gets.
 *
 * **Every runtime is asked, not only the one that runs today.** Detection is
 * allowed only when exactly one is signed in (0046 §3), so a probe that could
 * only ever answer `claude-code` would pick it on a machine signed in to both
 * and record *the only runtime signed in* — a reason that is false.
 *
 * Asked only when no file names `runtime.agent`, and the answer — an empty one
 * too — is remembered for `ttlMs`. Each probe is a process, and the board
 * resolves the recipe on every render (#112): an unremembered *none* would
 * start a `claude auth status` and a `codex login status` per project per
 * append. A minute is short enough that signing in, or out, is seen on a
 * later pass without anybody restarting anything.
 */
export function signedInProbe(
  runtimes: readonly Pick<Runtime, 'capabilities' | 'checkAuth'>[],
  ttlMs = 60_000,
  now: () => number = Date.now,
): SignedIn {
  let kept: { at: number; ids: Promise<readonly RuntimeId[]> } | null = null
  return () => {
    if (kept === null || now() - kept.at >= ttlMs) {
      const env = runnableEnv({})
      // Copilot is signed in by its own login or by the token a sandboxed run is handed (#1301): either admits it,
      // so an expired machine token cannot reject an unsandboxed project's working login. An unreadable file adds
      // nothing; the run and doctor's token row say so by name.
      let token: string | undefined
      try {
        const read = copilotGithubToken()
        token = read === undefined ? undefined : Redacted.value(read)
      } catch {
        token = undefined
      }
      // `SignedIn` is `@lingtai/recipe`'s promise port, so this stays a promise; `signedInIdsEffect` is the same question as an Effect.
      const ids = Promise.all(
        runtimes.map((r) =>
          Promise.resolve(r.checkAuth?.(env))
            .then((auth) =>
              auth?.loggedIn || token === undefined || r.capabilities.id !== 'copilot'
                ? auth
                : Promise.resolve(r.checkAuth?.({ ...env, COPILOT_GITHUB_TOKEN: token })),
            )
            .then((auth) => (auth?.loggedIn ? [r.capabilities.id] : [])),
        ),
      ).then((found) => found.flat())
      kept = { at: now(), ids }
    }
    return kept.ids
  }
}

/**
 * **Derived from the table, not written out** (`#313`).
 *
 * It was `[createClaudeCodeRuntime(), createCodexRuntime()]`, beside a docstring
 * promising *every* runtime — a list that would silently stop being every runtime
 * the day a third arrived, and the probe is the one place where a forgotten
 * runtime is invisible rather than broken: detection is allowed only when exactly
 * one is signed in, so a missing row makes *the only runtime signed in* a reason
 * that is false. `everyRuntime()` is `RUNTIMES`' own values.
 */
export const signedInHere: SignedIn = signedInProbe(everyRuntime())

/**
 * The recipe governing this project's next run: `~/.lingtai/<project>/recipe.yml`,
 * its `runtime.agent` included (`#372`)
 * ([0046](../../../doc/decisions-archive/0046-lingtai-is-personal.md) §3, #180).
 *
 * Read from the file every time rather than from anything stored: a snapshot
 * in Lingtai's database would be a second source of truth. The read also records an
 * edit the log has not seen (`loadProject`, 0128 §6) and never writes the file;
 * `store` is the log it reads and appends to, the process's own when absent. No request is made
 * and nothing is read from the repository — an agent's blast radius is its
 * worktree, and this file is not in it, which is what 0005's *read from the
 * base branch* used to buy. `client` is unused and kept so every caller that
 * conducts still passes through the one `RecipeFor` shape.
 *
 * `base` becomes `ref`: the file has no branch of its own, so the branch this
 * project was registered against stands in, and `baseDivergence` still
 * compares it with the recipe's `branch.main`.
 *
 * **`StepsResolved` does store a recipe, and it is not that snapshot** (0047
 * §1, 0128 §4). It records the recipe a run that is *over* was given, beside the hash it
 * is verified by — a record, like `baseSha`, and nothing resolves from it. What
 * this refuses is *deciding* from a copy; reading the log's copy here, or
 * anywhere in `conductor`, `recipe` or `actions`, would be exactly that, and
 * `unit/recorded-recipe.test.ts` fails if anything does.
 */
/**
 * What a lookup may be handed beyond a resolve's own: the three that default here and nowhere else. A test
 * names the host (`host`, `hostFacts`) so nothing spawns; production leaves both to `hostHere`.
 */
export type RecipeLookupOptions = Omit<LoadProjectOptions, 'base' | 'signedIn' | 'host' | 'hostFacts'> & {
  signedIn?: SignedIn
  host?: HostAnswer | 'skip'
  hostFacts?: HostFactsEffect
}

let hostProvider: HostAnswer | undefined

/**
 * A host that can load srt says how it answers (#1152). Only `apps/cli/src` may import `@lingtai/sandbox/live`
 * (the board imports this package, and must never load srt), so the CLI hands its answer in here at start.
 */
export const provideHostAnswer = (answer: HostAnswer): void => {
  hostProvider = answer
}

/**
 * The host answer, asked only for an enabled, required `sandbox:` block (#1147). **A process with no sandbox
 * runtime — the board — checks that the programs srt needs are installed instead of reporting success**, so setup still
 * warns on a host that cannot sandbox; the pass that would wrap decides again with srt's own answer.
 */
export const hostHere: HostAnswer = Effect.suspend(() => hostProvider ?? hostProgramsPresent())

/**
 * What the setup wizard reads of the host (#1160): the answer through `hostHere` (so srt is imported on the
 * first ask and never by a client graph), the install advice for `platform`, and the built-in allowlist.
 * Handed to `proposeSetup` only for a recipe that is new.
 */
export const sandboxHostHere = (platform: string = process.platform) => ({
  answer: hostHere,
  install: installFor(platform) ?? null,
  builtIns: BUILT_IN_DOMAINS,
})

export function currentRecipeEffect(
  state: ProjectState,
  _client?: unknown,
  base?: string,
  options: RecipeLookupOptions = {},
): Effect.Effect<ResolvedRecipe, Error> {
  const project = state.project
  if (!project) return Effect.fail(new Error('no repository name recorded — re-run lingtai add'))
  // A recipe that is missing or invalid is a typed failure carrying today's message, never a defect.
  // Through `loadProject`, so a hand edit the log has not seen is recorded by whichever reader gets here first (0128 §6).
  return loadProject(project, {
    ...options,
    base: base ?? state.base ?? null,
    signedIn: options.signedIn ?? signedInHere,
    host: options.host ?? hostHere,
    hostFacts: options.hostFacts ?? readHost,
  }).pipe(Effect.map((loaded) => loaded.recipe))
}

/** `currentRecipeEffect` as the promise the CLI and the board await (a listed face, #790). */
export function currentRecipe(
  state: ProjectState,
  client?: unknown,
  base?: string,
  options: RecipeLookupOptions = {},
): Promise<ResolvedRecipe> {
  return Effect.runPromise(currentRecipeEffect(state, client, base, options))
}
