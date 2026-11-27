import { exclusiveAdd } from '@lingtai/conductor/add-from-page'
import type { GithubReach } from '@lingtai/conductor/onboard'
import { taken } from '@lingtai/conductor/pick-repository'
import { githubAuthKind, storeChoice, type StoreChoice } from '@lingtai/env'
import { parseSlug } from '@lingtai/github'
import { recipePath, recipeText } from '@lingtai/project'
import { branchOf, type Recipe, resolveSource } from '@lingtai/recipe'
import {
  alreadyAdded,
  alreadyAddedSentence,
  type Answers,
  applySetup,
  keptSentence,
  type RepositoryList,
  SetupWriteError,
} from '@lingtai/setup'
import { Cause, Effect } from 'effect'

import {
  type AskedBeforeAdd,
  askBeforeGithubAddEffect,
  type AskBeforeGithubAddDeps,
  attempt,
  liveGithubDeps,
} from './add-github.ts'
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
import { ensureLabelsEffect, labelNames, liveLabelClient, type LabelClient } from './add-labels.ts'
import {
  chooseFirstProjectEffect,
  conflictingFlags,
  liveFirstProjectWorld,
  liveRepositoryListEffect,
  type FirstProjectWorld,
} from './first-project.ts'
import { githubIssueForms, type IssueForms } from './issue-forms.ts'
import { addSteps } from './next-steps.ts'
import { renderNextBlock, renderNextLine } from './output.ts'
import { interactivity, liveAsk, liveSpin } from './prompt.ts'
import { questionEffect } from './question.ts'
import { ADD_KEPT } from './recipe-flow.ts'
import { type CardRecipe, cardRecipe, type LeftBehind } from './setup-card.ts'
import { liveSetupDoctorEffect, printSetupEndEffect, type SetupDoctor } from './setup-end.ts'

export interface AddWorld {
  project: FirstProjectWorld
  /** `askBeforeGithubAdd`'s own deps — its live ones unless a test says otherwise. */
  githubDeps?: AskBeforeGithubAddDeps
  /** The client that makes the project's labels (#1486) — the live one (built from `reach`) unless a test says otherwise. */
  labels?: (owner: string, repo: string, reach: GithubReach) => Effect.Effect<Pick<LabelClient, 'createLabel'>, unknown>
  /** Reads the repository's issue forms (#1518) — the live read unless a test says otherwise; it cannot fail. */
  issueForms?: (owner: string, repo: string, reach: GithubReach) => Effect.Effect<IssueForms>
  error: (line: string) => void
  /** Where the card goes — the same `log` the questions were asked through. */
  log: (line: string) => void
  /** The report `init` runs, against the same home. */
  doctor: () => Effect.Effect<SetupDoctor, unknown>
  /** The store this machine answers with, read the way `init` reads it. */
  store: () => StoreChoice
  /** For the card's `~` substitution. */
  userHome: string
  /**
   * What a bare `lingtai add` offers instead of refusing (#969). Absent means
   * nothing is offered and the exit-2 sentence stands.
   */
  repositories?: {
    /** A script never sees a prompt: with no terminal this is false and nothing is read. */
    interactive: () => boolean
    /** Rejects with the sentence to print when the read failed. */
    list: () => Effect.Effect<RepositoryList, unknown>
  }
}

/** The last choice on the list: type the slug instead. */
const TYPE_IT = 'type owner/repo'

/**
 * Reads what this machine can list and asks which. Yields the slug picked or
 * typed, null when the person is not to be asked (the App is installed
 * nowhere, and its link was printed), or a refusal. A failed read never blocks
 * typing.
 */
const pickRepository = (world: AddWorld) =>
  Effect.gen(function* () {
    let offered: string[] = []
    const read = yield* attempt(Effect.suspend(() => world.repositories!.list()))
    if ('threw' in read) {
      // The list's failure is a sentence; typing `owner/repo` still works.
      world.log(`could not list your repositories — ${asError(read.threw).message}`)
    } else if (read.ok.kind === 'gh') {
      offered = read.ok.repositories.filter((r) => r.onboarded === null).map((r) => r.slug)
      if (read.ok.more) world.log('more not shown — type owner/repo')
    } else {
      const { picker } = read.ok
      if (picker.installations.length === 0) {
        if (picker.installUrl !== null) world.log(`the App is not installed anywhere yet: ${picker.installUrl}`)
        return null
      }
      // An installation that would not answer is a sentence under its account,
      // never an empty one.
      for (const i of picker.installations) {
        if (i.unanswered !== null) {
          world.log(`could not list ${i.installation.account}'s repositories — ${i.unanswered}`)
        }
      }
      offered = picker.installations.flatMap((i) =>
        i.repositories.filter((r) => r.onboarded === null).map((r) => r.slug),
      )
    }
    const validate = (answer: string): Effect.Effect<string | null> =>
      Effect.sync(() => {
        try {
          parseSlug(answer)
          return null
        } catch (err) {
          return (err as Error).message
        }
      })
    const kept = 'Nothing was registered.'
    if (offered.length > 0) {
      const chosen = yield* questionEffect(world.project, {
        name: 'the repository',
        flag: '<owner/repo>',
        given: null,
        prompt: 'which repository',
        fallback: offered[0]!,
        offer: [...offered, TYPE_IT],
        validate: (answer) => (answer === TYPE_IT ? Effect.succeed(null) : validate(answer)),
        kept,
      })
      if ('refused' in chosen) return { refused: chosen.refused }
      if (chosen.answer !== TYPE_IT) return chosen.answer
    }
    const typed = yield* questionEffect(world.project, {
      name: 'the repository',
      flag: '<owner/repo>',
      given: null,
      prompt: 'owner/repo',
      fallback: '',
      validate,
      kept,
    })
    return 'refused' in typed ? { refused: typed.refused } : typed.answer
  })

const asError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)))

export const addFlowEffect = Effect.fn('add.addFlow')(function* (
  args: { positional?: string | undefined; flags: Record<string, string>; repeated: Record<string, string[]> },
  world: AddWorld,
): Effect.fn.Return<number, unknown> {
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
    const done = yield* githubProjectEffect(slug, flags, buildFlags, world, { command: 'add', homeIsNew: false })
    if (done.exit === 0 && done.closing !== undefined) closeOn(world, done.fix, done.closing)
    return done.exit
  }

  // A bare `lingtai add --agent …` (GitHub named or chosen at the prompt) reaches the picker below:
  // the board branch refuses the recipe flags it does not ask, so it is told to
  // leave them out (the local branch keeps them) and they are handed on with the pick, where `askBeforeGithubAdd` asks.
  const holdsBack =
    flags['project'] !== 'local' && flags['local'] === undefined && world.repositories?.interactive() === true
  // `--github-auth` names how this machine reaches GitHub, and is the machine list's flag: answered here, ahead of the
  // project, where nothing is in force yet, so `gh` is checked and written like any other answer of that entry.
  if (
    flags['github-auth'] !== undefined &&
    flags['project'] !== 'local' &&
    flags['local'] === undefined &&
    (world.project.github.auth?.() ?? null) === null
  ) {
    // The refusals `chooseFirstProject` would make are made first: this writes `github.auth`, so a refusal after it
    // could not say that nothing was written.
    const conflict = conflictingFlags(flags, world.project.kept)
    if (conflict !== null) {
      world.error(conflict)
      return 1
    }
    const answered = yield* (world.githubDeps ?? liveGithubDeps).githubAuth!(flags)
    if ('refused' in answered) {
      world.error(answered.refused)
      return 1
    }
  }
  const result = yield* chooseFirstProjectEffect(world.project, flags, buildFlags, holdsBack)
  if ('refused' in result) {
    world.error(result.refused)
    return 1
  }
  if (
    result.project === 'github' &&
    result.slug === undefined &&
    result.app === 'already' &&
    world.repositories?.interactive() === true
  ) {
    // The pick goes back through this same function as if it had been typed,
    // so the access check, the recipe questions and the card are not written
    // twice. The auth question was settled on this pass; the kind is told.
    const picked = yield* pickRepository(world)
    if (typeof picked === 'object' && picked !== null) {
      world.error(picked.refused)
      return 1
    }
    if (picked !== null && picked !== '') {
      return yield* addFlowEffect(
        { ...args, positional: undefined, flags: { ...flags, project: 'github', github: picked } },
        world,
      )
    }
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
    const end = yield* printSetupEndEffect(
      world,
      {
        command: 'add',
        project: result.name,
        updated: result.updated,
        ...(result.unchanged === true ? { unchanged: true } : {}),
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
    closeOn(world, end.fix, {
      project: result.name,
      tickets: result.card.tickets,
      kinds: result.card.kinds,
      slug: null,
    })
  }
  return 0
})

/** Which command is drawing the card, and what only it knows (`init`'s config is new, and its store may have left things). */
export interface GithubProjectEntry {
  command: 'add' | 'init'
  homeIsNew: boolean
  /** What the command's own earlier steps left behind, ahead of the project's. */
  leftBehind?: readonly LeftBehind[]
  /** The day's ceiling `init`'s list asked about or was told, as the card's `spend` row. */
  spend?: string
}

/** What the project's setup came to; the command closes on `closing` (or `fix`) itself, and exits `exit`. */
export interface GithubProjectDone {
  exit: number
  fix?: string
  closing?: Parameters<typeof addSteps>[0]
}

/**
 * The one setup path for a GitHub project (ADR 0125 §6), run by `lingtai add <owner>/<repo>` and by
 * `lingtai init --github <owner>/<repo>`. A first run adds the project; a later run asks every question
 * the first did, each defaulting to what the recipe says now, and writes only a change.
 */
export const githubProjectEffect = Effect.fn('add.githubProject')(function* (
  slug: string,
  flags: Record<string, string>,
  buildFlags: string[],
  world: AddWorld,
  entry: GithubProjectEntry,
): Effect.fn.Return<GithubProjectDone, unknown> {
  // An owner never recorded (`filter.ts`'s "re-run lingtai add <owner>/<repo>") asks nothing, writes no recipe and only registers again.
  const repo = slugRepo(slug)
  const found = repo === null ? undefined : alreadyAdded(yield* world.project.projects(), repo)
  const ownerRepair = found !== undefined && found.owner === null && found.configHash !== null
  const rerun = found !== undefined && !ownerRepair
  let repaired: string | null = null
  // Whether `ProjectConfigured` names the base the recipe on disk names: a rerun that left them apart registers again.
  let registeredAsRecipe = false
  if (ownerRepair) repaired = repo
  if (rerun && repo !== null) {
    const { owner } = parseSlug(slug)
    // Another owner's repository of the same name would be written onto this project's stream.
    if (found.owner !== null && found.owner.toLowerCase() !== owner.toLowerCase()) {
      world.error(taken({ slug, repo, takenBy: found.owner }))
      return { exit: 1 }
    }
    // The project is keyed by its registered spelling: another spelling would read and write a recipe of its own.
    if (found.project !== repo) {
      world.error(
        `${repo} is registered as ${found.project} — run lingtai add ${owner}/${found.project} instead. Nothing was written`,
      )
      return { exit: 1 }
    }
    // A recipe that does not resolve is refused by name before any question, never replaced by the defaults (0125 §6).
    const recipeAt = recipePath(repo)
    const text = yield* recipeText(repo, world.project.store === undefined ? {} : { store: world.project.store })
    if (text !== null) {
      try {
        // Registered means `ProjectConfigured` was appended (a pending project has no hash) naming the base the
        // registration records: `branchOf`, the personal branch in team mode.
        registeredAsRecipe =
          found.configHash !== null &&
          found.base !== null &&
          found.base === branchOf(resolveSource(text, recipeAt, recipeAt).recipe)
      } catch (error) {
        world.error(`${recipeAt} does not resolve — ${asError(error).message}. ${ADD_KEPT}`)
        return { exit: 1 }
      }
    }
  }
  // This command registers a GitHub project; a flag that names another kind is refused where it is read, not after.
  if (flags['project'] !== undefined && flags['project'] !== 'github') {
    world.error(`${slug} is a GitHub project, and --project ${flags['project']} names another. Nothing was written`)
    return { exit: 1 }
  }

  let asked: AskedBeforeAdd | null = null
  if (!ownerRepair) {
    const stopped = yield* askBeforeGithubAddEffect(slug, flags, world.githubDeps, buildFlags)
    if (typeof stopped === 'number') return { exit: stopped }
    asked = stopped
  }

  // Nothing changed: no event, nothing registered. The recipe is read back, the labels are put right, the card says so.
  if (rerun && asked !== null && asked.answers.changes.length === 0 && registeredAsRecipe) {
    const { owner, repo: name } = parseSlug(slug)
    // The conflicts `chooseFirstProject` would refuse, which this return would otherwise step over.
    const conflict = conflictingFlags(flags, entry.command === 'add' ? ADD_KEPT : world.project.kept)
    if (conflict !== null) {
      world.error(conflict)
      return { exit: 1 }
    }
    // The same election `chooseFirstProject` would hold the flag to: the machine reaches GitHub one way.
    const via = flags['github-auth']
    if (via !== undefined && asked.reach !== undefined && via !== asked.reach.kind) {
      world.error(
        `--github-auth ${via}, but this machine reaches GitHub through ${asked.reach.kind === 'gh' ? 'gh' : 'the App'}. ` +
          'Leave out --github-auth, or change it with lingtai init. Nothing was written',
      )
      return { exit: 1 }
    }
    return yield* drawGithubCard(world, entry, {
      owner,
      repo: name,
      asked,
      updated: true,
      unchanged: true,
      reach: asked.reach ?? { kind: 'app', slug: null },
      warnings: [],
    })
  }

  // With a slug, `askBeforeGithubAdd` above has written nothing but `github.auth`, the machine's own: its answers are held in `asked`, and
  // `applySetup` writes them just before the registration they belong to.
  const base = { ...world.project, kept: entry.command === 'add' ? ADD_KEPT : world.project.kept }
  const pending = asked
  const projectWorld: typeof base =
    pending === null
      ? base
      : {
          ...base,
          github: { ...base.github, add: (opts, log) => addWithSetup(base, pending.answers, opts, log, rerun) },
        }
  // An `app` answered above writes nothing yet, so it is told on rather than asked a second time (#1487).
  const handed = asked?.githubAuth === undefined ? flags : { ...flags, 'github-auth': asked.githubAuth }
  const result = yield* chooseFirstProjectEffect(projectWorld, handed, buildFlags, false)
  if ('refused' in result) {
    world.error(result.refused)
    return { exit: 1 }
  }
  if (result.project !== 'github') {
    world.error(`${slug} is a GitHub project, and --project ${result.project} names another. Nothing was written`)
    return { exit: 1 }
  }
  if (asked !== null && result.updated !== undefined && result.reach !== undefined) {
    const { owner, repo: name } = parseSlug(result.slug!)
    return yield* drawGithubCard(world, entry, {
      owner,
      repo: name,
      asked,
      updated: result.updated,
      reach: result.reach,
      warnings: result.warnings ?? [],
    })
  }
  if (asked !== null && (result.updated === undefined || result.reach === undefined)) {
    // `add()` said why; nothing was registered, and a script must not read this as success.
    world.error(`${slug} was not registered`)
    return { exit: 1 }
  }
  if (repaired !== null && result.updated !== undefined) {
    world.log(`${repaired}'s recipe is ${recipePath(repaired)}, and it is edited there`)
  }
  return { exit: 0 }
})

/** The card a GitHub project ends on: the recipe read back as written, the labels put right, and what to do next. */
const drawGithubCard = Effect.fn('add.githubCard')(function* (
  world: AddWorld,
  entry: GithubProjectEntry,
  card: {
    owner: string
    repo: string
    asked: AskedBeforeAdd
    updated: boolean
    unchanged?: boolean
    reach: GithubReach
    warnings: readonly string[]
  },
): Effect.fn.Return<GithubProjectDone, unknown> {
  const { owner, repo, asked, reach } = card
  // Warnings come first and whatever the read-back does: the project is registered either way.
  for (const line of card.warnings) world.log(line)
  const path = recipePath(repo)
  // The card reads the recipe back as written, as the local path does; a read that fails says so and draws no card.
  const read = yield* attempt(
    Effect.gen(function* () {
      const text = yield* recipeText(repo, world.project.store === undefined ? {} : { store: world.project.store })
      if (text === null) return yield* Effect.fail(new Error(`${path} is not there to read`))
      const recipe: Recipe = resolveSource(text, path, path).recipe
      return { card: cardRecipe(recipe, `${owner}/${repo}`), recipe }
    }),
  )
  if ('threw' in read) {
    world.error(`${repo} is registered, but its recipe could not be read back for the summary — ${read.threw.message}`)
    return { exit: 1 }
  }
  const recipeCard: CardRecipe = read.ok.card
  // Never fails the add: a label that could not be made is on the card with the line that makes it (#1486).
  const labels = yield* ensureLabelsEffect(
    Effect.suspend(() => (world.labels ?? liveLabelClient)(owner, repo, reach)),
    labelNames(read.ok.recipe),
  )
  const forms = yield* Effect.suspend(() => (world.issueForms ?? githubIssueForms)(owner, repo, reach)).pipe(
    Effect.catchCause(() => Effect.succeed<IssueForms>({ kind: 'none' })),
  )
  const left = [...(entry.leftBehind ?? []), ...(asked.leftBehind ?? [])]
  const end = yield* printSetupEndEffect(
    world,
    {
      command: entry.command,
      project: repo,
      updated: card.updated,
      ...(card.unchanged === true ? { unchanged: true } : {}),
      home: world.project.home,
      homeIsNew: entry.homeIsNew,
      userHome: world.userHome,
      store: world.store(),
      runtimes: asked.runtimes,
      where: 'github',
      github: githubRow(reach),
      recipe: recipeCard,
      labels: { slug: `${owner}/${repo}`, created: labels.created, missing: labels.missing },
      trial: asked.trial,
      recipePath: path,
      ...(entry.spend === undefined ? {} : { spend: entry.spend }),
      ...(left.length === 0 ? {} : { leftBehind: left }),
    },
    asked.hints,
  )
  return {
    exit: 0,
    ...(end.fix === undefined ? {} : { fix: end.fix }),
    closing: {
      project: repo,
      tickets: recipeCard.tickets,
      kinds: recipeCard.kinds,
      slug: `${owner}/${repo}`,
      takes: recipeCard.takes,
      forms,
    },
  }
})

function slugRepo(slug: string): string | null {
  try {
    return parseSlug(slug).repo
  } catch {
    return null
  }
}

type Added = Effect.Success<ReturnType<FirstProjectWorld['github']['add']>>

class Declined extends Error {
  readonly result: Added
  constructor(result: Added) {
    super('declined')
    this.result = result
  }
}

/**
 * `applySetup` over the GitHub registration (`add()`, `onboard.ts`): the recipe the questions decided is
 * written, once, and the project registered.
 */
function addWithSetup(
  world: FirstProjectWorld,
  answers: Answers,
  opts: Parameters<FirstProjectWorld['github']['add']>[0],
  log: (line: string) => void,
  rerun: boolean,
): Effect.Effect<Added> {
  // The default home, as `askBeforeGithubAdd` read the file and as the card below reads it back.
  const path = recipePath(answers.project)
  // Under the lock the board's Add takes, and on a first add with *already added* read again inside it: another
  // process may have registered this project since the first read. A rerun is registered by definition.
  const guarded = world.projects().pipe(
    // A store failure is a defect (0101 §6), which `Effect.catch` does not see; an interruption is let through.
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause as Cause.Cause<never>)
        : Effect.fail(
            new SetupWriteError(
              `could not read the projects: ${Cause.squash(cause) instanceof Error ? (Cause.squash(cause) as Error).message : Cause.squash(cause)}`,
            ),
          ),
    ),
    Effect.flatMap((projects) =>
      rerun || alreadyAdded(projects, answers.project) === undefined
        ? applySetup(
            { by: world.by, store: world.store },
            answers,
            world.github.add(opts, log).pipe(
              Effect.mapError((err) => (err instanceof Error ? err : new Error(String(err)))),
              Effect.flatMap((result) => (result.ok ? Effect.succeed(result) : Effect.fail(new Declined(result)))),
            ),
          )
        : Effect.fail(new SetupWriteError(alreadyAddedSentence(answers.project))),
    ),
  )
  return exclusiveAdd(answers.project, guarded, world.locker).pipe(
    Effect.map((done): Added => done.registered),
    Effect.catch((error): Effect.Effect<Added> => {
      if (error instanceof Declined) {
        // `add()` said why; the recipe was written before it did.
        log(keptSentence(path))
        return Effect.succeed(error.result)
      }
      log(error instanceof SetupWriteError ? error.message : `${error.message} — ${keptSentence(path)}`)
      return Effect.succeed({ ok: false } as Added)
    }),
  )
}

/** The last thing `add` prints (0121 §1): a failed doctor's one line, else the numbered block. */
function closeOn(world: Pick<AddWorld, 'log'>, fix: string | undefined, source: Parameters<typeof addSteps>[0]): void {
  if (fix !== undefined) {
    world.log(renderNextLine(fix))
    return
  }
  for (const line of renderNextBlock(addSteps(source))) world.log(line)
}

/** `gh, signed in as me`, `gh, signed in` when it named no login, or `the App x`. */
export function githubRow(reach: GithubReach): string {
  if (reach.kind === 'app') return reach.slug === null ? 'the App' : `the App ${reach.slug}`
  return reach.login === null ? 'gh, signed in' : `gh, signed in as ${reach.login}`
}

export function liveAddWorld(): AddWorld {
  return {
    project: liveFirstProjectWorld({ ask: liveAsk, spin: liveSpin, log: (line) => console.log(line) }),
    error: (line) => console.error(line),
    log: (line) => console.log(line),
    doctor: liveSetupDoctorEffect,
    store: () => storeChoice(process.env),
    userHome: process.env['HOME'] ?? '',
    repositories: {
      interactive: () => {
        const how = interactivity(false)
        return how.stdinIsTTY && how.stdoutIsTTY
      },
      list: () => liveRepositoryListEffect(githubAuthKind() ?? 'app'),
    },
  }
}
