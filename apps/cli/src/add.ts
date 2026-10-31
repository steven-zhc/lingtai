import { storeChoice, type StoreChoice } from '@lingtai/env'
import { recipePath } from '@lingtai/recipe'

/**
 * `lingtai add <owner>/<repo>`, or — since #394 — `lingtai add` with no
 * positional, which asks the same GitHub-or-directory question `lingtai init`
 * does, through the one function both share (`chooseFirstProject`).
 *
 * Its own module, separate from `lingtai.ts`, because that file's last lines
 * call `main()` on import (#435) — a test importing it would run the whole
 * CLI. `addFlow` is the body `lingtai.ts`'s old `addCommand` used to carry;
 * `lingtai.ts` keeps a three-line wrapper that builds the live world and
 * calls it.
 *
 * A bare slug is still `--github <owner>/<repo>`, so every invocation that
 * worked before this still does. Tier, gates and the base are the recipe's,
 * in the managed repository, which is why the GitHub branch takes a slug and
 * — at most — the branch to find the file on: `--base`, named because a
 * person typed it here, is refused rather than silently adopted when the
 * recipe disagrees (#75).
 */
import { askBeforeGithubAdd, type AskBeforeGithubAddDeps } from './add-github.ts'
import { chooseFirstProject, liveFirstProjectWorld, type FirstProjectWorld } from './first-project.ts'
import { liveAsk, liveSpin } from './prompt.ts'
import { ADD_KEPT } from './recipe-flow.ts'
import { liveSetupDoctor, printSetupEnd, type SetupDoctor } from './setup-end.ts'

export interface AddWorld {
  project: FirstProjectWorld
  /** `askBeforeGithubAdd`'s own deps — its live ones unless a test says otherwise. */
  githubDeps?: AskBeforeGithubAddDeps
  error: (line: string) => void
  /** Where the card goes — the same `log` the questions were asked through. */
  log: (line: string) => void
  /** The report `init` runs, against the same home. */
  doctor: () => Promise<SetupDoctor>
  /** The store this machine answers with, read the way `init` reads it. */
  store: () => StoreChoice
  /** For the card's `~` substitution. */
  userHome: string
}

export async function addFlow(
  args: { positional?: string | undefined; flags: Record<string, string>; repeated: Record<string, string[]> },
  world: AddWorld,
): Promise<number> {
  const { flags, repeated } = args
  const positional = args.positional === undefined ? [] : [args.positional]
  const buildFlags = repeated['build'] ?? []
  // A positional beside either flag names a second project, and neither one
  // may be dropped without a word (#394's review).
  for (const flag of ['local', 'github'] as const) {
    if (positional[0] !== undefined && flags[flag] !== undefined && flags[flag] !== positional[0]) {
      world.error(
        `lingtai add ${positional[0]} and --${flag} ${flags[flag]} name two different projects. Pass one or the ` +
          'other. Nothing was written',
      )
      return 1
    }
  }
  if (positional[0] !== undefined && flags['local'] === undefined) {
    flags['github'] = positional[0]
  }

  const slug = flags['github']
  if (slug !== undefined && slug !== '') {
    const stopped = await askBeforeGithubAdd(slug, flags, world.githubDeps, buildFlags)
    if (stopped !== null) return stopped
  }

  // With a slug, `askBeforeGithubAdd` above has written each answer it was
  // given, so a refusal from here on keeps them rather than undoing them.
  const projectWorld = slug !== undefined && slug !== '' ? { ...world.project, kept: ADD_KEPT } : world.project

  const result = await chooseFirstProject(projectWorld, flags, buildFlags)
  if ('refused' in result) {
    world.error(result.refused)
    return 1
  }
  if (result.project === 'github' && result.slug === undefined) {
    // Nothing was registered — the same claim `lingtai add <owner>/<repo>`
    // with no slug at all used to refuse with exit 2, before #394 let a bare
    // `lingtai add` reach this branch with no slug of its own. A script
    // checking the exit code must not read this as success (#394 finding 3).
    world.error(
      'no repository was picked — run lingtai add <owner>/<repo>, or lingtai init --project github to use the board',
    )
    return 2
  }
  if (result.project === 'local') {
    await printSetupEnd(
      world,
      {
        command: 'add',
        project: result.name,
        updated: result.updated,
        home: world.project.home,
        // Only `init` writes `config.yml`.
        homeIsNew: false,
        userHome: world.userHome,
        store: world.store(),
        runtimes: result.runtimes,
        recipe: result.card,
        trial: result.trial,
        recipePath: recipePath(result.name, world.project.home),
      },
      result.hints,
    )
  }
  return 0
}

export function liveAddWorld(): AddWorld {
  return {
    project: liveFirstProjectWorld({ ask: liveAsk, spin: liveSpin, log: (line) => console.log(line) }),
    error: (line) => console.error(line),
    log: (line) => console.log(line),
    doctor: liveSetupDoctor,
    store: () => storeChoice(process.env),
    userHome: process.env['HOME'] ?? '',
  }
}
