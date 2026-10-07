/**
 * What `lingtai add` checks, asks and writes before a GitHub project is
 * registered (#398, #399, #402), once a slug is known. Its own module because
 * `lingtai.ts`'s last lines call `main()` on import, so a unit test cannot
 * import this out of it.
 *
 * In order: `--land` against `--base`; then — before a single question is
 * asked or a single answer written, and only where there is an App on this
 * machine to ask — whether it is installed here and grants what Lingtai
 * needs (#402); then the writer and reviewer; then, once a recipe is already
 * there, the ticket source and the kinds (#396), the landing branch and the
 * limits. Each answer is written as soon as it is given, not collected for
 * one write at the end. With no App configured at all, every question below
 * still runs: a recipe written for a project whose App does not exist yet is
 * what lets `chooseFirstProject` offer to create it next, in the same run.
 * Null to go on to the registration, or the exit code to stop with. A local
 * project, and a GitHub one picked on the board, reach none of this yet.
 */
import { checkInstallation } from '@lingtai/conductor/onboard'
import { githubApp, hasGitHubApp } from '@lingtai/env'
import { createGitHubClient, type Installation, installationForRepo, parseSlug } from '@lingtai/github'
import { diskFiles, readRecipeKey, recipePath, setRecipe } from '@lingtai/recipe'

import { askAgents } from './agents.ts'
import { askLanding, askLimits } from './landing.ts'
import { liveAsk, type QuestionWorld } from './question.ts'
import { askRuntimes } from './runtimes.ts'
import { askKinds, askTickets, liveHistory } from './source.ts'

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

export interface AskBeforeGithubAddDeps {
  check: typeof checkInstallation
  read: (path: string) => Promise<string | null>
  write: typeof setRecipe
  ask: (prompt: string) => Promise<string | null>
}

const liveDeps: AskBeforeGithubAddDeps = {
  check: checkInstallation,
  read: diskFiles.read,
  write: setRecipe,
  ask: liveAsk,
}

export async function askBeforeGithubAdd(
  slug: string,
  flags: Record<string, string>,
  deps: AskBeforeGithubAddDeps = liveDeps,
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
        console.error(checked.filter((l) => l.trim() !== '').join('\n'))
        return 1
      }
      installation = found
    } catch (err) {
      // `githubApp()`, inside `deps.check`'s lookup, rethrows anything that
      // is not `NotInstalledError` — a malformed key, a revoked key (401), an
      // unreachable GitHub. `runGithubBranch`'s own `app.configured &&
      // !app.ok` guard named this the same way before #402 moved the check
      // ahead of it; that guard is never reached now, so this is the only
      // place left to name it.
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
  const existing = await deps.read(path)
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
  } else {
    // A file that `extends:` a preset and writes no `steps:` of its own
    // inherits every step from the preset — the first `steps.*` answer below
    // pins that preset's steps into the file for good (`write.ts`'s
    // `widenStepsIfNeeded`). Named here, before the writer question, because
    // showing that to a person is this caller's line to print, not
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
    const asked = await askAgents(world, { project: repo, runtimes, flags: agentFlags })
    if ('refused' in asked) {
      console.error(asked.refused)
      return 1
    }
    // `changes` sets an action's `agent:` (or creates it) and `modelChanges`
    // that same action's `model:`, written one after the other.
    await deps.write(repo, asked.changes)
    await deps.write(repo, asked.modelChanges)
  }

  // The questions are asked before add() runs, and only when the recipe is
  // already there — an absent one is add()'s own refusal to speak, and
  // nothing here seeds a file that cannot resolve on its own (#395). `existing`
  // rather than `existsSync(path)`: both agree on the real filesystem (where
  // `deps.read` defaults to `diskFiles.read`, null on ENOENT exactly as
  // `existsSync` is false), but a test's `deps.read` stub must be able to say
  // there is no recipe without this function reaching past it to the disk.
  if (existing !== null) {
    // #396's two questions, asked and written before `askLanding` — each as
    // soon as it is answered, so a Ctrl+C at either keeps what came before it.
    // `addCommand` hands this same `flags` object to `chooseFirstProject`
    // once this function returns — deleted as soon as each is read, so that
    // call's `runGithubBranch` does not see them again and refuse what this
    // function already asked and wrote (#396 fix round, finding 1).
    const givenTickets = flags['tickets'] ?? null
    delete flags['tickets']
    const tickets = await askTickets(world, repo, false, givenTickets, {
      history: liveHistory,
      kept: 'the writer and reviewer chosen above are kept',
    })
    if ('refused' in tickets) {
      console.error(tickets.refused)
      return 1
    }
    if (tickets.changes.length > 0) await deps.write(repo, tickets.changes)

    const givenKinds = flags['kinds'] ?? null
    delete flags['kinds']
    const kinds = await askKinds(world, repo, givenKinds, {
      kept: 'the writer, reviewer and ticket source chosen above are kept',
    })
    if ('refused' in kinds) {
      console.error(kinds.refused)
      return 1
    }
    if (kinds.changes.length > 0) await deps.write(repo, kinds.changes)

    const landed = await askLanding(world, repo, land ?? null, {
      defaultBranch: () => defaultBranchOf(owner, repo, installation),
    })
    if ('refused' in landed) {
      console.error(landed.refused)
      return 1
    }
    const limited = await askLimits(
      world,
      repo,
      { rounds: flags['rounds'], wall: flags['wall'], budget: flags['budget'] },
      {},
    )
    if ('refused' in limited) {
      console.error(limited.refused)
      return 1
    }
  }

  return null
}
