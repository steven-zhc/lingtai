/**
 * What `lingtai add` checks, asks and writes before a GitHub project is
 * registered (#398, #399, #402), once a slug is known. Its own module because
 * `lingtai.ts`'s last lines call `main()` on import, so a unit test cannot
 * import this out of it.
 *
 * In order: `--land` against `--base`; then — before a single question is
 * asked or a single answer written, and only where there is an App on this
 * machine to ask — whether it is installed here and grants what Lingtai
 * needs (#402); then, once a recipe is already there, one `askRecipe` call
 * (#431) asks the writer and reviewer, the install and build commands, the
 * ticket source and the kinds (#396), the landing branch and the limits, in
 * that order. Each answer is written as soon as it is given, not collected
 * for one write at the end. With no App configured at all, every question
 * below still runs: a recipe written for a project whose App does not exist
 * yet is what lets `chooseFirstProject` offer to create it next, in the same
 * run. Null to go on to the registration, or the exit code to stop with. A
 * local project, and a GitHub one picked on the board, reach none of this
 * yet.
 */
import { checkInstallation } from '@lingtai/conductor/onboard'
import { alreadyOnboarded, choose, type Choice, type Picker, refusalLines } from '@lingtai/conductor/pick-repository'
import { githubApp, hasGitHubApp } from '@lingtai/env'
import { createGitHubClient, GitHubError, type Installation, installationForRepo, parseSlug } from '@lingtai/github'
import { diskFiles, readRecipeKey, recipePath, type RecipeFiles } from '@lingtai/recipe'

import { EMPTY_SETUP_READER, type SetupReader } from './detect-setup.ts'
import { livePicker } from './first-project.ts'
import { liveAsk, type QuestionWorld } from './question.ts'
import { ADD_KEPT, askRecipe } from './recipe-flow.ts'
import { askRuntimes } from './runtimes.ts'
import { liveHistory } from './source.ts'

/**
 * The repository's default branch, through the same calls `checkInstallation`
 * and `add()` make to read it — asked here only as a fallback for the land
 * question's own default, and answered null on any failure, since a
 * question's `detected` is just one more thing a person can type past (#399).
 *
 * `installation`, when the caller already asked GitHub for it — the early
 * check below has, and a second request would ask the same question again
 * for no reason (#402).
 */
async function defaultBranchOf(owner: string, repo: string, installation?: Installation): Promise<string | null> {
  try {
    const auth = githubApp()
    const resolved = installation ?? (await installationForRepo(auth, owner, repo))
    const client = await createGitHubClient({ auth, owner, repo, installation: resolved })
    return await client.defaultBranch()
  } catch {
    return null
  }
}

/**
 * `askRecipe`'s `reader`, over a GitHub ref — `has` through the raw contents
 * endpoint rather than `fileAt`, for `detect-setup.ts`'s own reason: the
 * contents API leaves `content` empty for a file between 1 and 100 MB, and a
 * `has` built on `fileAt` alone would call the biggest lockfiles absent.
 *
 * With no installation, no ref, or any failure building the client, every
 * question still runs — an empty reader's `has` rejects rather than
 * resolving `false`, so `detectSetup` reads it as "could not tell" rather
 * than a confirmed absence (#431 fix round, finding 2); a detection
 * suggestion is never worth failing the whole setup over, and
 * `detectInstall`/`detectSetup` catch that rejection rather than letting it
 * reach this function's own caller.
 */
async function liveGithubReader(
  owner: string,
  repo: string,
  installation: Installation | undefined,
  ref: string | null,
): Promise<SetupReader> {
  if (installation === undefined || ref === null) return EMPTY_SETUP_READER
  try {
    const auth = githubApp()
    const client = await createGitHubClient({ auth, owner, repo, installation })
    return {
      has: async (path) => {
        try {
          await client.request('GET', `/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`)
          return true
        } catch (err) {
          // A missing file is an answer; anything else (a 403, a 500) is not
          // one — `fileAt` draws the same line at `client.ts:420`, and
          // swallowing both the same way read a transient failure as a
          // confirmed absence (#431 fix round, finding 2).
          if (err instanceof GitHubError && err.status === 404) return false
          throw err
        }
      },
      read: async (path) => {
        try {
          return await client.fileAt(path, ref)
        } catch {
          return null
        }
      },
    }
  } catch {
    return EMPTY_SETUP_READER
  }
}

export interface AskBeforeGithubAddDeps {
  check: typeof checkInstallation
  /**
   * `choose()`'s own picker — asked only once `deps.check` has already
   * refused, to turn that refusal into the sentence and deep link
   * `runGithubBranch`'s slug path would have given it (#402 fix round 3,
   * `pick-repository.ts:199`). Never asked on the path that succeeds, so a
   * successful add costs no second request.
   */
  picker: () => Promise<Picker>
  files: RecipeFiles
  reader: (
    owner: string,
    repo: string,
    installation: Installation | undefined,
    ref: string | null,
  ) => Promise<SetupReader>
  ask: (prompt: string) => Promise<string | null>
}

const liveDeps: AskBeforeGithubAddDeps = {
  check: checkInstallation,
  picker: livePicker,
  files: diskFiles,
  reader: liveGithubReader,
  ask: liveAsk,
}

export async function askBeforeGithubAdd(
  slug: string,
  flags: Record<string, string>,
  deps: AskBeforeGithubAddDeps = liveDeps,
  /** Every `--build <cmd>` on the command line, in order — `flags['build']` alone is only the last (#431 fix round, finding 3). */
  buildFlags: readonly string[] = [],
): Promise<number | null> {
  // Tier, gates and the base are the recipe's, in the managed repository, which
  // is why this takes a slug and — at most — the branch to find the file on.
  // `named`, because a person typed it here: a recipe that contradicts `--base`
  // is refused rather than adopted (#75), which is a refusal only a typed flag
  // may earn.
  const base = flags['base']
  const land = flags['land']
  // `--land <branch>` and `--base` are different questions — where to read the
  // recipe from, and what it should land on — and a person who named both must
  // not have one silently overrule the other (#399, mirroring #75's rule for
  // `--base` against the recipe's own `repo.base`).
  if (base !== undefined && land !== undefined && land !== 'hold' && land !== base) {
    console.error(
      `--land ${land} and --base ${base} name two different branches, and this command will not pick one ` +
        'silently. Nothing was written',
    )
    return 2
  }

  const { owner, repo } = parseSlug(slug)

  // With no App configured on this machine at all, there is nothing yet to
  // check — `checkInstallation`'s default lookup calls `githubApp()`, which
  // throws rather than answering "not installed". The questions below still
  // run and still write, exactly as this command did before #402: a recipe
  // written for a project whose App was never created is what lets
  // `chooseFirstProject` offer to create one next, in the same run.
  //
  // Is the App installed here at all, and does it grant what Lingtai needs —
  // checked before a single question is asked or a single answer written
  // (#402), when there is an App to check at all. The check prints nothing on
  // success; `add()` runs the same check again later and prints its own
  // lines through `runGithubBranch`'s `said`, and printing them here too
  // would show every successful add the same two lines twice.
  let installation: Installation | undefined
  if (hasGitHubApp()) {
    const checked: string[] = []
    try {
      const found = await deps.check(slug, (line) => checked.push(line))
      if (found === null) {
        // `deps.check` only ever says *not installed* or *a gap*, never which
        // repository the App can see instead, or where to fix it — that is
        // `choose()`'s (`pick-repository.ts:199`), and `runGithubBranch`'s
        // slug path would have reached it had this check not refused first
        // (#402 fix round 3). Asked only here, on the refusal, so a
        // successful add still costs the one request `deps.check` already
        // made and nothing more.
        //
        // **Not for a project Lingtai already has.** There `choose()` answers
        // *already onboarded*, a sentence for the picker's offer-it-once
        // screen, and it would replace `checkInstallation`'s gap list, which
        // is the real reason for the exit 1 (#402 review, the guard
        // `first-project.ts` has for the same reason).
        let picked: Choice | null = null
        try {
          const picker = await deps.picker()
          picked = alreadyOnboarded(picker, slug) ? null : choose(picker, slug)
        } catch {
          picked = null
        }
        console.error(
          picked !== null && !picked.ok
            ? refusalLines(picked).join('\n')
            : checked.filter((l) => l.trim() !== '').join('\n'),
        )
        return 1
      }
      installation = found
    } catch (err) {
      // `githubApp()`, inside `deps.check`'s lookup, rethrows anything that
      // is not `NotInstalledError` — a malformed key, a revoked key (401), an
      // unreachable GitHub. `runGithubBranch`'s own `app.configured &&
      // !app.ok` guard named this the same way before #402 moved the check
      // ahead of it on `lingtai add`'s path; `lingtai init` still reaches
      // that guard through `chooseFirstProject` (`init.ts:461`), which never
      // calls this function, so this is only the place *this* command
      // names it.
      console.error(
        `the GitHub App configured here does not answer — ${(err as Error).message}. Fix its credentials, or ` +
          'remove them, and run this again. Nothing was written',
      )
      return 1
    }
  }

  // Which agent writes the change, and which cold-reviews it, is asked here —
  // before `add()` resolves the recipe — because `resolveLocalRecipe` throws
  // `AgentUnresolvedError` on a file naming no `runtime.agent` the moment more
  // than one runtime is signed in (`#398`). An absent recipe is not created
  // here (`doc/design/398.md`): with no file, `add()` still refuses with
  // `RecipeMissingError` as it always has, except a flag naming an agent is
  // refused by name rather than silently ignored.
  const path = recipePath(repo)
  const existing = await deps.files.read(path)
  const agentFlags = {
    agent: flags['agent'],
    model: flags['model'],
    reviewer: flags['reviewer'],
    reviewerModel: flags['reviewer-model'],
  }
  const world: QuestionWorld = { ask: deps.ask, log: (line) => console.log(line) }
  if (existing === null) {
    if (Object.values(agentFlags).some((v) => v !== undefined)) {
      console.error(`--agent needs a recipe to write into; there is none at ${path}. Nothing was written`)
      return 1
    }
    return null
  }

  // A file that `extends:` a preset and writes no `steps:` of its own
  // inherits every step from the preset — the first `steps.*` answer below
  // pins that preset's steps into the file for good (`write.ts`'s
  // `widenStepsIfNeeded`). Named here, before `askRecipe`'s first question,
  // because showing that to a person is this caller's line to print, not
  // `agents.ts`'s.
  const extendsPreset = await readRecipeKey(repo, ['extends'])
  const stepsWritten = await readRecipeKey(repo, ['steps'])
  if (typeof extendsPreset === 'string' && stepsWritten === null) {
    console.log(
      `${path} extends ${extendsPreset} and writes no steps: of its own — the first answer here pins that ` +
        "preset's steps into the file, so a later change to the preset no longer reaches this project",
    )
  }

  const runtimes = await askRuntimes()
  // Memoized, and shared with `askLanding`'s own `detected`, inside
  // `askRecipe` — asking GitHub for the default branch twice for one run is
  // one request nobody needed.
  let cachedDefaultBranch: Promise<string | null> | null = null
  const defaultBranch = () => (cachedDefaultBranch ??= defaultBranchOf(owner, repo, installation))
  const ref = base ?? (await defaultBranch())
  const reader = await deps.reader(owner, repo, installation, ref)

  const recipeResult = await askRecipe(world, {
    project: repo,
    local: false,
    runtimes,
    reader,
    flags,
    buildFlags,
    defaultBranch,
    history: liveHistory,
    kept: ADD_KEPT,
    files: deps.files,
  })
  // `addCommand` hands this same `flags` object to `chooseFirstProject` once
  // this function returns — deleted here, so that call's `runGithubBranch`
  // does not see them again and refuse what `askRecipe` already asked and
  // wrote (#396 fix round, finding 1; #431 fix round, finding 2).
  for (const name of [
    'tickets',
    'kinds',
    'agent',
    'model',
    'reviewer',
    'reviewer-model',
    'install',
    'build',
    'land',
    'rounds',
    'wall',
    'budget',
  ]) {
    delete flags[name]
  }
  if ('refused' in recipeResult) {
    console.error(recipeResult.refused)
    return 1
  }

  return null
}
