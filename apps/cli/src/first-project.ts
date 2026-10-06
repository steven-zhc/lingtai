/**
 * The first question `init` and `add` share (#394): a GitHub repository, or a
 * directory on this machine with its own `origin`.
 *
 * **One function, both callers.** `initCommand` and `addCommand` both call
 * `chooseFirstProject`, which asks through `question()` (#392) and the App
 * questions of #393's `askFirstProject`, and declares the slice of the world
 * it needs (`FirstProjectWorld`) rather than depending on `InitWorld` —
 * `question.ts` and `github-app.ts` already follow that rule, and `add` has no
 * `InitWorld` to depend on.
 *
 * **Remembering the answer is registering the project, not writing it down
 * twice.** Nothing machine-wide holds `local` or `github`; a project once
 * registered *is* the record, and `init`'s own printed list of what is
 * registered (`init.ts`) is how a machine with only local projects is told
 * how to add a GitHub one, rather than being asked the same question again.
 *
 * **The local branch writes nothing until everything has been checked.** The
 * directory is a git repository, it has an `origin` (the merge lane pushes
 * there — `packages/actions/src/merge-action.ts:47`), its name is not already
 * another project's, the base branch exists, and an agent can run here — only
 * then does `setRecipe` write `repo.base` and `repo.remote`, `resolveLocalRecipe`
 * reads the file back for its `configHash`, and `register` (`addLocal` in
 * `@lingtai/conductor/onboard`) appends `ProjectConfigured` with `owner: null`.
 *
 * **The GitHub branch is #393's App step, unchanged, plus the picker.** No App
 * configured runs `askFirstProject`'s App question and `waitForApp`; a slug
 * given or asked for is checked against `listRepositories` (`choose`,
 * `@lingtai/conductor/pick-repository`) and handed to `add`
 * (`@lingtai/conductor/onboard`) exactly as `lingtai add <owner>/<repo>` does
 * today.
 */
import { execFile, spawn } from 'node:child_process'
import { basename, resolve as resolvePath } from 'node:path'
import { promisify } from 'node:util'

import { add, addLocal, type AddOptions } from '@lingtai/conductor/onboard'
import { choose, listRepositories, type Picker } from '@lingtai/conductor/pick-repository'
import { loadAllProjects, signedInHere } from '@lingtai/conductor/projects'
import type { ProjectState } from '@lingtai/domain'
import { boardPort, githubApp, stateDir } from '@lingtai/env'
import { createAppReader, type Installation, parseSlug } from '@lingtai/github'
import {
  AgentUnresolvedError,
  diskFiles,
  PROPOSED_KINDS,
  readRecipeKey,
  recipePath,
  resolveAgent,
  resolveLocalRecipe,
  setRecipe,
  writtenAgent,
  type RecipeFiles,
  type ResolvedRecipe,
  type SignedIn,
} from '@lingtai/recipe'

import { checkApp, pollForApp, type AppCheck } from './app-check.ts'
import { boardAt } from './board.ts'
import {
  APP_WAIT_MS,
  appComeBackLine,
  askFirstProject,
  waitForApp,
  type AppWaitResult,
  type AppWaitWorld,
} from './github-app.ts'
import { question, type QuestionWorld } from './question.ts'

/** `world.git(dir, args)` — never a shell string, so a path never has to be escaped. */
export interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
}

export interface RegisterLocalPayload {
  project: string
  owner: null
  base: string
  configHash: string
  fromSha: string
  /** Already resolved by the caller, so `register` need not read the file again. */
  resolved: ResolvedRecipe
}

export interface FirstProjectWorld extends QuestionWorld {
  git: (dir: string, args: readonly string[]) => Promise<GitResult>
  /** `loadAllProjects` — registered and pending alike, keyed by name. */
  projects: () => Promise<readonly ProjectState[]>
  files: RecipeFiles
  /** `stateDir()` unless a test says otherwise. */
  home: string
  signedIn: SignedIn
  /** Appends `ProjectConfigured` and returns the "added" or "updated" line. */
  register: (payload: RegisterLocalPayload) => Promise<string>
  /**
   * `init`'s only (#393): a configured App already answers *is the project*,
   * so the question is refused past rather than asked, and `--project`/
   * `--github-app` naming anything else is refused by name. `lingtai add` has
   * none of this — a machine with an App configured for other projects can
   * still add a local one (#394's finding 5), so it always asks, skipping only
   * the now-moot "create the App" sub-question when one already answers.
   */
  githubAppIsTheProject?: boolean
  github: {
    app: () => Promise<AppCheck>
    /** A board already running, or null — `add` starts none of its own. */
    boardUrl: () => Promise<string | null>
    waitForApp: (boardUrl: string) => Promise<AppWaitResult>
    picker: () => Promise<Picker>
    add: (options: AddOptions, log: (line: string) => void) => Promise<number>
  }
}

export type FirstProjectOutcome =
  | { ok: true; project: 'local'; name: string; remote: string; base: string }
  | { ok: true; project: 'github'; app: 'already' | AppWaitResult; slug?: string }
  | { refused: string }

/** Why a combination of flags cannot both be obeyed, or null when they can. */
function conflictingFlags(flags: Record<string, string>): string | null {
  const local = flags['local']
  const github = flags['github']
  if (local !== undefined && github !== undefined) {
    return `--local ${local} and --github ${github} name two different projects. Pass one or the other. Nothing was written`
  }
  if (local !== undefined && flags['project'] === 'github') {
    return `--local ${local}, but --project github names the other kind. Leave out --project, or leave out --local. Nothing was written`
  }
  if (local !== undefined && flags['github-app'] !== undefined) {
    return (
      `--github-app ${flags['github-app']}, but --local ${local} creates no GitHub App. Leave out --github-app, ` +
      'or leave out --local. Nothing was written'
    )
  }
  if (github !== undefined && flags['project'] === 'local') {
    return `--github ${github}, but --project local names the other kind. Leave out --project, or leave out --github. Nothing was written`
  }
  return null
}

/**
 * Just the project-kind half of #393's `askFirstProject` — asked on its own
 * when an App is already configured and `lingtai add` is the caller, since
 * the App sub-question ("create it now, or skip") is moot with one already
 * answering. `askFirstProject` itself is not split to produce this: its
 * contract is pinned by `github-app.test.ts`, which asks both questions every
 * time and must keep doing so.
 */
async function askProjectKind(
  world: QuestionWorld,
  flags: Record<string, string>,
): Promise<{ kind: 'local' | 'github' } | { refused: string }> {
  const kept = 'the store chosen above is kept'
  const kind = await question(world, {
    name: 'the project',
    flag: '--project github, or --project local',
    given: flags['project'] ?? null,
    prompt: 'a GitHub project, or one on this machine only',
    fallback: 'github',
    choices: ['github', 'local'],
    kept,
  })
  if ('refused' in kind) return { refused: kind.refused }
  if (kind.answer === 'local') {
    if (flags['github-app'] !== undefined) {
      return {
        refused:
          `--github-app ${flags['github-app']}, but --project local creates no GitHub App. Leave out ` +
          `--github-app, or pass --project github. ${kept}`,
      }
    }
    return { kind: 'local' }
  }
  return { kind: 'github' }
}

export async function chooseFirstProject(
  world: FirstProjectWorld,
  flags: Record<string, string>,
): Promise<FirstProjectOutcome> {
  const conflict = conflictingFlags(flags)
  if (conflict !== null) return { refused: conflict }

  let kind: 'local' | 'github' | null =
    flags['local'] !== undefined ? 'local' : flags['github'] !== undefined ? 'github' : null
  let askedApp: 'create' | 'skip' | null = null
  // Fetched at most once here, and handed to `runGithubBranch` rather than
  // left for it to ask again — `world.github.app()` is a real call (`GET
  // /app`, or `init`'s already-fetched one), and asking it twice for one run
  // is a second one nobody needed.
  let appCheck: AppCheck | null = null

  if (kind === null) {
    const app = await world.github.app()
    appCheck = app
    if (app.configured && !app.ok) {
      return {
        refused:
          `the GitHub App configured here does not answer — ${app.why}. Fix its credentials, or remove them, ` +
          'and run this again. Nothing was written',
      }
    }
    if (app.configured && world.githubAppIsTheProject === true) {
      const namedProject = flags['project'] ?? null
      if (namedProject !== null && namedProject !== 'github') {
        return {
          refused:
            `--project ${namedProject}, but a GitHub App is already configured here — the project is github ` +
            'already. Remove the App first, or leave out --project. Nothing was written',
        }
      }
      if (flags['github-app'] !== undefined && flags['github-app'] !== 'skip') {
        return {
          refused:
            `--github-app ${flags['github-app']}, but a GitHub App is already configured here and none is ` +
            'created now. Leave out --github-app, or pass --github-app skip. Nothing was written',
        }
      }
      kind = 'github'
    } else if (app.configured) {
      // The project question is still asked — unlike `init`, a machine with
      // an App configured for other projects can still add a local one
      // (#394's finding 5) — but the "create the App" sub-question is moot
      // with one already answering, so an explicit request for one is refused
      // rather than silently obeyed, and nothing beyond that is asked.
      if (flags['github-app'] !== undefined && flags['github-app'] !== 'skip') {
        return {
          refused:
            `--github-app ${flags['github-app']}, but a GitHub App is already configured here and none is ` +
            'created now. Leave out --github-app, or pass --github-app skip. Nothing was written',
        }
      }
      const asked = await askProjectKind(world, flags)
      if ('refused' in asked) return { refused: asked.refused }
      kind = asked.kind
    } else {
      const asked = await askFirstProject(world, flags)
      if ('refused' in asked) return { refused: asked.refused }
      if (asked.project === 'local') kind = 'local'
      else {
        kind = 'github'
        askedApp = asked.app
      }
    }
  }

  return kind === 'local'
    ? runLocalBranch(world, flags, flags['local'] ?? null)
    : runGithubBranch(world, flags, flags['github'] ?? null, askedApp, appCheck)
}

/** Git recognises a URL (`scheme://…`) and scp-style (`[user@]host:path`) — everything else is a path. */
function isUrlOrScpLike(remote: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(remote) || /^[^@/\s]+@[^/\s]+:/.test(remote)
}

/** `origin` as git stores it, resolved to an absolute path when it is a relative one. */
function resolveRemote(remote: string, top: string): string {
  return isUrlOrScpLike(remote) ? remote : resolvePath(top, remote)
}

async function runLocalBranch(
  world: FirstProjectWorld,
  flags: Record<string, string>,
  givenDir: string | null,
): Promise<FirstProjectOutcome> {
  const dirAnswer = await question(world, {
    name: 'the directory',
    flag: '--local <dir>',
    given: givenDir,
    prompt: 'the directory of the repository on this machine',
  })
  if ('refused' in dirAnswer) return { refused: dirAnswer.refused }
  const dir = dirAnswer.answer

  const top = await world.git(dir, ['rev-parse', '--show-toplevel'])
  if (!top.ok) {
    return { refused: `${dir} is not a git repository — ${(top.stderr || top.stdout).trim()}. Nothing was written` }
  }
  const toplevel = top.stdout.trim()

  const origin = await world.git(toplevel, ['remote', 'get-url', 'origin'])
  if (!origin.ok) {
    return {
      refused:
        `${toplevel} has no origin — ${(origin.stderr || origin.stdout).trim()}. The merge lane pushes to the ` +
        "repository's own origin (packages/actions/src/merge-action.ts:47), and there is nothing to push to " +
        'without one. Add one with git remote add origin <url>, and run this again. Nothing was written',
    }
  }
  const remote = resolveRemote(origin.stdout.trim(), toplevel)
  const name = basename(toplevel)

  const registered = await world.projects()
  const found = registered.find((p) => p.project === name)
  if (found !== undefined && found.owner !== null) {
    return {
      refused:
        `a project called ${name} is already registered as ${found.owner}/${name}, and a project is keyed by its ` +
        'name — pick another directory, or remove that project first. Nothing was written',
    }
  }
  if (found !== undefined && found.owner === null) {
    // `repo.remote` is optional in the schema (`recipe.ts`), so a project
    // registered before owners were recorded — #352's `unrecorded` state —
    // may have none at all. Missing is never treated as a match: there is
    // nothing here to confirm this directory is the same project, and
    // proceeding would silently re-point an existing GitHub project's stream
    // at this local directory.
    const existingRemote = await readRecipeKey(name, ['repo', 'remote'], { home: world.home, files: world.files })
    if (existingRemote !== remote) {
      return {
        refused:
          typeof existingRemote === 'string'
            ? `a project called ${name} is already registered with repo.remote: ${existingRemote}, and ${toplevel}'s ` +
              `origin is ${remote} — a project is keyed by its name, and registering this directory would silently ` +
              'redirect it to this one. Remove the existing project first, or rename this directory. Nothing was written'
            : `a project called ${name} is already registered with no repo.remote recorded — it may be a project ` +
              'registered before owners were, and there is nothing here to confirm this directory is the same one ' +
              `— and a project is keyed by its name, so registering ${toplevel} here would silently redirect it ` +
              'to this directory instead. Remove the existing project first, or rename this directory. Nothing was written',
      }
    }
  }

  let fromSha = ''
  const currentBase = await readRecipeKey(name, ['repo', 'base'], { home: world.home, files: world.files })
  const symbolic = await world.git(toplevel, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  const current = symbolic.ok ? null : await world.git(toplevel, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const detected = symbolic.ok
    ? symbolic.stdout.trim().replace(/^origin\//, '')
    : current?.ok
      ? current.stdout.trim()
      : null

  const baseAnswer = await question(world, {
    name: 'the base branch',
    flag: '--base <branch>',
    given: flags['base'] ?? null,
    prompt: "the branch this project's recipe governs and merges into",
    current: typeof currentBase === 'string' ? currentBase : null,
    detected,
    validate: async (answer) => {
      const check = await world.git(toplevel, ['rev-parse', '--verify', `${answer}^{commit}`])
      if (!check.ok) return `${answer} is not a branch in ${toplevel} — ${(check.stderr || check.stdout).trim()}`
      fromSha = check.stdout.trim()
      return null
    },
  })
  if ('refused' in baseAnswer) return { refused: baseAnswer.refused }
  const base = baseAnswer.answer

  const path = recipePath(name, world.home)
  const existingText = await world.files.read(path)
  const written = existingText === null ? 'absent' : writtenAgent(existingText)
  if (written !== 'not a runtime') {
    try {
      await resolveAgent(written === 'absent' ? null : { agent: written, from: path }, world.signedIn, path)
    } catch (err) {
      if (!(err instanceof AgentUnresolvedError)) throw err
      return { refused: err.message }
    }
  }

  // `source.kinds` and `env.plantAt` have no schema default (`recipe.ts`'s
  // `KINDS`, `plantAt: z.string()`) — a brand-new file needs both or it will
  // not resolve at all, and nothing a directory offers answers either for it.
  // Written only when there is no file yet: an existing one already has them,
  // possibly edited since, and a re-run must not overwrite that silently.
  const changes = [
    { path: ['repo', 'base'], value: base },
    { path: ['repo', 'remote'], value: remote },
    ...(existingText === null
      ? [
          { path: ['source', 'kinds'], value: [...PROPOSED_KINDS] },
          { path: ['env', 'plantAt'], value: '.env.local' },
        ]
      : []),
  ]
  try {
    await setRecipe(name, changes, { home: world.home, files: world.files })
  } catch (err) {
    return { refused: (err as Error).message }
  }

  const resolved = await resolveLocalRecipe(name, {
    home: world.home,
    signedIn: world.signedIn,
    base,
    read: world.files.read,
  })

  // `register`'s live implementation (`addLocal`) logs the "added"/"updated"
  // line itself — logging it again here printed it twice.
  await world.register({
    project: name,
    owner: null,
    base,
    configHash: resolved.configHash,
    fromSha,
    resolved,
  })
  return { ok: true, project: 'local', name, remote, base }
}

async function runGithubBranch(
  world: FirstProjectWorld,
  flags: Record<string, string>,
  givenSlug: string | null,
  askedApp: 'create' | 'skip' | null,
  knownApp: AppCheck | null,
): Promise<FirstProjectOutcome> {
  const app = knownApp ?? (await world.github.app())
  if (app.configured && !app.ok) {
    return {
      refused:
        `the GitHub App configured here does not answer — ${app.why}. Fix its credentials, or remove them, and ` +
        'run this again. Nothing was written',
    }
  }

  let appOutcome: 'already' | AppWaitResult = 'already'

  if (!app.configured) {
    let appAnswer = askedApp
    if (appAnswer === null) {
      const asked = await askFirstProject(world, { ...flags, project: 'github' })
      if ('refused' in asked) return { refused: asked.refused }
      appAnswer = asked.project === 'github' ? asked.app : 'create'
    }

    const boardUrl = await world.github.boardUrl()
    if (boardUrl === null) {
      return {
        refused:
          'no board is running here to create the GitHub App on — start one with lingtai init --project github, ' +
          'or lingtai board, then run this again. Nothing was written',
      }
    }

    if (appAnswer === 'skip') {
      world.log(appComeBackLine(boardUrl, 'skipped'))
      return { ok: true, project: 'github', app: { skipped: true } }
    }

    const waited = await world.github.waitForApp(boardUrl)
    if (!('made' in waited)) return { ok: true, project: 'github', app: waited }
    appOutcome = waited
  }

  if (givenSlug === null) return { ok: true, project: 'github', app: appOutcome }

  const picker = await world.github.picker()
  // `choose()`'s "already onboarded" is written for the picker's offer-it-once
  // screen, not for re-running `lingtai add` on a project this is — the
  // `registrationLine` "updated" path (#163), and `unrecorded()`'s own advice
  // to run exactly this command for the owner it names. `add()` resolves the
  // installation itself (`installationForRepo`), so the given owner is the
  // disambiguation rather than something `choose()` has to confirm first.
  const { owner, repo } = parseSlug(givenSlug)
  const alreadyOnboarded = picker.installations
    .flatMap((listed) => listed.repositories)
    .some(
      (r) =>
        r.owner.toLowerCase() === owner.toLowerCase() &&
        r.repo.toLowerCase() === repo.toLowerCase() &&
        (r.onboarded === 'registered' || r.onboarded === 'pending' || r.onboarded === 'unrecorded'),
    )
  let installation: Installation | undefined
  if (!alreadyOnboarded) {
    const picked = choose(picker, givenSlug)
    if (!picked.ok) return { refused: picked.why }
    installation = picked.installation
  }

  const said: string[] = []
  const baseFlag = flags['base']
  const code = await world.github.add(
    {
      slug: givenSlug,
      installation,
      base: baseFlag === undefined ? undefined : { ref: baseFlag, named: true },
    },
    (line) => {
      said.push(line)
      world.log(line)
    },
  )
  if (code !== 0) {
    return { refused: said.filter((l) => l.trim() !== '').join('\n') || `${givenSlug} could not be registered` }
  }
  return { ok: true, project: 'github', app: appOutcome, slug: givenSlug }
}

// ------------------------------------------------------------- live world --

const execFileAsync = promisify(execFile)

/** Exported for `init.ts`'s `liveInitWorld()` — one real `git`, not two. */
export async function liveGit(dir: string, args: readonly string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args as string[], { cwd: dir })
    return { ok: true, stdout, stderr }
  } catch (err) {
    const failed = err as { stdout?: string; stderr?: string; message: string }
    return { ok: false, stdout: failed.stdout ?? '', stderr: failed.stderr ?? failed.message }
  }
}

function liveOpen(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
    const child = spawn(opener, [url], { stdio: 'ignore', detached: true })
    child.once('error', () => resolve(false))
    child.once('spawn', () => {
      child.unref()
      resolve(true)
    })
  })
}

async function liveInstallUrl(): Promise<string | null> {
  const app = await checkApp()
  return app.configured && app.ok ? `https://github.com/apps/${app.slug}/installations/new` : null
}

/** Exported for `init.ts`'s `liveInitWorld()` — one real picker, not two. */
export async function livePicker(): Promise<Picker> {
  const credentials = githubApp()
  const reader = createAppReader({ appId: credentials.appId, privateKey: credentials.privateKey })
  const [projects, installUrl] = await Promise.all([loadAllProjects(), liveInstallUrl()])
  return listRepositories({ reader, projects, installUrl })
}

export interface LiveFirstProjectOptions {
  ask: (prompt: string) => Promise<string | null>
  log: (line: string) => void
  /** Known already — the board `init` just started. Discovered via `boardAt(boardPort())` when absent (`lingtai add`). */
  boardUrl?: string
  appWait?: Pick<AppWaitWorld, 'open' | 'appeared' | 'pressed'>
}

/**
 * The live seam for both `lingtai init` and `lingtai add` — everything
 * `chooseFirstProject` asks of the world, built for real: a real `git`, the
 * real log (`loadAllProjects`, `addLocal`), the real recipe files, and the
 * real GitHub App.
 *
 * `appWait` lets `init` hand in its own `open`/`appeared`/`pressed` — it
 * already has a browser opener and a keypress-skip wired to its own
 * `InitWorld` — and defaults to one with no keypress-skip for `add`, which has
 * no raw-mode terminal wait of its own.
 */
export function liveFirstProjectWorld(options: LiveFirstProjectOptions): FirstProjectWorld {
  const appWait: Pick<AppWaitWorld, 'open' | 'appeared' | 'pressed'> = options.appWait ?? {
    open: liveOpen,
    appeared: pollForApp,
    pressed: (signal) =>
      new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })),
  }
  const home = stateDir()

  return {
    ask: options.ask,
    log: options.log,
    git: liveGit,
    projects: () => loadAllProjects(),
    files: diskFiles,
    home,
    signedIn: signedInHere,
    register: (payload) =>
      addLocal(
        { project: payload.project, base: payload.base, configHash: payload.configHash, fromSha: payload.fromSha },
        payload.resolved,
        options.log,
      ),
    github: {
      app: checkApp,
      boardUrl: async () => options.boardUrl ?? (await boardAt(boardPort())),
      waitForApp: (boardUrl) => waitForApp({ log: options.log, ...appWait }, boardUrl, { waitMs: APP_WAIT_MS }),
      picker: livePicker,
      add: (opts: AddOptions, log) => add(opts, log),
    },
  }
}
