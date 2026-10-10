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
import { liveAsk } from './question.ts'
import { ADD_KEPT } from './recipe-flow.ts'

export interface AddWorld {
  project: FirstProjectWorld
  /** `askBeforeGithubAdd`'s own deps — its live ones unless a test says otherwise. */
  githubDeps?: AskBeforeGithubAddDeps
  error: (line: string) => void
}

/**
 * `--flag value` pairs plus positionals. Enough for three commands — moved
 * here from `lingtai.ts` (#435) rather than left there, since every other
 * caller of it still imports from that file, and `addFlow` cannot.
 *
 * A flag whose next token is another flag, or which ends the line, is a boolean
 * and consumes nothing. Without that rule `--no-merge --no-conduct` parsed as
 * `no-merge: "--no-conduct"` and swallowed the second flag whole, so the second
 * stayed on while the command line said to turn it off — a flag that reads as
 * ignored is the one kind that is worse than a flag that errors.
 *
 * `flags` is last-wins, as every caller here already reads it; `repeated`
 * carries every occurrence of every flag, in order, for the one caller that
 * needs more than the last — `--build <cmd>` is repeatable (`setup-build.ts`'s
 * own refusal says so), and `flags['build']` alone cannot say that back (#431
 * fix round, finding 3).
 */
export function parseFlags(args: string[]): {
  positional: string[]
  flags: Record<string, string>
  repeated: Record<string, string[]>
} {
  const positional: string[] = []
  const flags: Record<string, string> = {}
  const repeated: Record<string, string[]> = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a.startsWith('--')) {
      const next = args[i + 1]
      const name = a.slice(2)
      // `--defaults` names no value — unlike every other flag here, whose
      // boolean reading only fires when the next token looks like a flag
      // too. Without this, `lingtai add --defaults owner/repo` would read
      // `owner/repo` as `--defaults`'s value and drop it from `positional`
      // (#433).
      if (name === 'defaults' || next === undefined || next.startsWith('--')) {
        flags[name] = ''
        ;(repeated[name] ??= []).push('')
      } else {
        flags[name] = next
        ;(repeated[name] ??= []).push(next)
        i++
      }
    } else {
      positional.push(a)
    }
  }
  return { positional, flags, repeated }
}

export async function addFlow(args: string[], world: AddWorld): Promise<number> {
  const { positional, flags, repeated } = parseFlags(args)
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
  return 0
}

export function liveAddWorld(): AddWorld {
  return {
    project: liveFirstProjectWorld({ ask: liveAsk, log: (line) => console.log(line) }),
    error: (line) => console.error(line),
  }
}
