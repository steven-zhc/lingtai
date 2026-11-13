/**
 * What the board's step 2 of "add a repository" reads and writes (#971): the
 * proposal behind the form, the preview beside it, and the one write.
 *
 * **The page's server half is these Effects and nothing else.** The proposal is
 * `proposeSetup` over live readers; the preview is `previewSetup` over the
 * answers built by `setupAnswers`; the write is `applySetup` with a registration
 * that is the one `lingtai add` makes (`add` for a GitHub repository, `addLocal`
 * for a directory). The page hands in plain form answers and never a
 * `RecipeChange[]`.
 *
 * **A local directory's tickets are `db`.** `proposeSetup` proposes `github` for
 * a directory whose `origin` is on GitHub, but the registration of a directory
 * is `owner: null` and `ownerlessRefusal` (`filter.ts`) refuses every pass of an
 * ownerless project whose recipe says `github` — so `localTicketsOf` is where
 * the page overrides it, and #977 deletes that function with the rule.
 *
 * **Every read is an Effect.** The ports `@lingtai/setup` types as promises are
 * filled with `runPort`, one call per member, until they are Effect ports.
 */
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

import type { ProjectState } from '@lingtai/domain'
import { githubApp, githubClientAuth } from '@lingtai/env'
import { createFileLocker, type Locker } from '@lingtai/env/lock'
import { GitHubFailed, makeGitHub, type GitHub } from '@lingtai/github'
import { baseOf, diskFiles, type RecipeFiles, recipePath, resolveLocalRecipe, resolveSource } from '@lingtai/recipe'
import { gitEffect } from '@lingtai/repo'
import {
  alreadyAdded,
  alreadyAddedSentence,
  applySetup,
  askRuntimes,
  keptSentence,
  LINGTAI_BASE,
  previewSetup,
  proposeSetup,
  readLocalRepository,
  refusalOf,
  type Proposal,
  type ProposalReaders,
  type SetupForm,
  setupAnswers,
  type SetupReader,
  type SetupTarget,
  SetupWriteError,
} from '@lingtai/setup'
import { Effect } from 'effect'

import { addEffect, addLocalEffect } from './onboard.ts'
import { asFailure, runPort } from './port-face.ts'
import { loadAllProjects, signedInHere } from './projects.ts'
import { liveHistory } from './ticket-history.ts'

const reasonOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** `git <args>` in `cwd`: never fails, `ok: false` carries git's own words. */
const gitIn = (cwd: string, args: readonly string[]) =>
  gitEffect([...args], { cwd }).pipe(
    Effect.match({
      onSuccess: (out) => ({ ok: true, out: out.trim() }),
      onFailure: (err) => ({ ok: false, out: err.detail }),
    }),
  )

/** The directory a typed path names — re-read on the server, never taken from the query string. */
export function readLocalTarget(input: string) {
  return readLocalRepository(input, {
    home: homedir(),
    stat: (path) =>
      Effect.tryPromise(() => stat(path)).pipe(
        Effect.match({
          onSuccess: (s) => (s.isDirectory() ? ('directory' as const) : ('file' as const)),
          onFailure: () => 'missing' as const,
        }),
      ),
    git: gitIn,
  })
}

/** The Effect client over a GitHub repository: the saved `gh` login, or the App's installation on it. */
const githubFor = (owner: string, repo: string) =>
  Effect.try({ try: () => githubClientAuth(), catch: asFailure }).pipe(
    Effect.flatMap((auth) =>
      'kind' in auth && auth.kind === 'gh'
        ? makeGitHub({ auth: { kind: 'gh' }, owner, repo })
        : Effect.try({ try: () => githubApp(), catch: asFailure }).pipe(
            Effect.flatMap((app) => makeGitHub({ auth: app, owner, repo })),
          ),
    ),
  )

/** Files in a checkout on this machine. */
const diskReader = (dir: string): SetupReader => ({
  has: (path) =>
    runPort(
      Effect.tryPromise(() => stat(join(dir, path))).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      ),
    ),
  read: (path) =>
    runPort(
      Effect.tryPromise(() => readFile(join(dir, path), 'utf8')).pipe(Effect.orElseSucceed((): string | null => null)),
    ),
})

/**
 * Files in a GitHub repository at its default branch; a 404 is an absence,
 * anything else is "could not tell". `client` and `ref` are cached Effects: one
 * installation lookup and one default-branch read serve every member call.
 */
function githubReader(
  client: Effect.Effect<GitHub, Error>,
  ref: Effect.Effect<string, Error>,
  owner: string,
  repo: string,
): SetupReader {
  return {
    has: (path) =>
      runPort(
        Effect.gen(function* () {
          const g = yield* client
          const branch = yield* ref
          return yield* g
            .request('GET', `/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`)
            .pipe(
              Effect.as(true),
              Effect.catchIf(
                (err) => err instanceof GitHubFailed && err.status === 404,
                () => Effect.succeed(false),
              ),
            )
        }),
      ),
    read: (path) =>
      runPort(
        Effect.gen(function* () {
          const g = yield* client
          const branch = yield* ref
          return yield* g.fileAt(path, branch)
        }).pipe(Effect.orElseSucceed((): string | null => null)),
      ),
  }
}

/** The readers a proposal reads through, for one target. */
export function liveReaders(target: SetupTarget): Effect.Effect<ProposalReaders> {
  if (target.kind === 'github') {
    const { owner, repo } = target
    return Effect.gen(function* () {
      const client = yield* Effect.cached(githubFor(owner, repo))
      const ref = yield* Effect.cached(Effect.flatMap(client, (g) => g.defaultBranch()))
      return {
        setupReader: githubReader(client, ref, owner, repo),
        defaultBranch: () => runPort(ref),
        runtimes: askRuntimes,
        history: liveHistory,
        origin: () => Promise.resolve(null),
      }
    })
  }
  return Effect.succeed({
    setupReader: diskReader(target.path),
    // A directory lands on `lingtai-base`, made from the branch it is on (0104 §15), not on the branch checked out.
    defaultBranch: () => Promise.resolve(LINGTAI_BASE),
    runtimes: askRuntimes,
    history: liveHistory,
    origin: (path) =>
      runPort(
        gitIn(path, ['remote', 'get-url', 'origin']).pipe(Effect.map((r) => (r.ok && r.out !== '' ? r.out : null))),
      ),
  })
}

/** Every line step 2 shows, read once; a failed read is a `known: false` line and not an error. */
export function proposalFor(target: SetupTarget, readers?: ProposalReaders): Effect.Effect<Proposal, never> {
  return readers
    ? proposeSetup(target, readers)
    : Effect.flatMap(liveReaders(target), (live) => proposeSetup(target, live))
}

/**
 * The ticket source a directory can take. A directory is registered with no
 * owner, so `github` is not one of its choices yet (#977), whatever its
 * `origin` says; the sentence says why the line reads `db`.
 */
export function localTicketsOf(proposal: Proposal): { source: 'db'; because: string } {
  const onGithub = proposal.tickets.known && proposal.tickets.value.repository !== null
  return {
    source: 'db',
    because: onGithub
      ? 'its origin is on GitHub, but a local directory cannot take its issues yet (#977) — Lingtai keeps its own tickets'
      : proposal.tickets.known
        ? proposal.tickets.because
        : proposal.tickets.reason,
  }
}

/** The recipe text the form would write, or why it would not resolve — nothing is written. */
export function previewOf(
  form: SetupForm,
  ports: { home?: string; files?: RecipeFiles } = {},
): Effect.Effect<{ text: string } | { refused: string }, never> {
  const refused = refusalOf(form)
  if (refused !== null) return Effect.succeed({ refused })
  return answersFor(form, ports).pipe(
    Effect.flatMap((answers) => previewSetup(ports, answers)),
    Effect.match({ onSuccess: (text) => ({ text }), onFailure: (err) => ({ refused: err.message }) }),
  )
}

/** The answers, written in full when a recipe is already on disk (`setupChanges`' `rewrite`). */
function answersFor(form: SetupForm, ports: { home?: string; files?: RecipeFiles }) {
  const files = ports.files ?? diskFiles
  return Effect.tryPromise({
    try: () => files.read(recipePath(form.project, ports.home)),
    catch: (err) => new SetupWriteError(`could not read the recipe: ${reasonOf(err)}`),
  }).pipe(Effect.map((existing) => setupAnswers(form, existing !== null)))
}

export interface AddPorts {
  home?: string
  files?: RecipeFiles
  /** Every project with a stream: the reads `lingtai add` refuses an add from. */
  projects: () => Promise<readonly ProjectState[]>
  /** Where the cross-process lock is taken; the machine's lock directory unless a test hands one in. */
  locker?: Locker
  /** The registration that follows the write. Fails with the sentence to show. */
  register: (form: SetupForm) => Effect.Effect<void, Error>
}

export type Added = { ok: true; project: string; path: string } | { ok: false; say: string }

/**
 * The one write: refuse a project already added, write the recipe once, then
 * register. A recipe written and not registered stays, and the next Add writes
 * over it and registers (`applySetup`'s own rule); a double-click is refused
 * because the first one's stream is there.
 */
export function addProject(form: SetupForm, ports: AddPorts): Effect.Effect<Added, never> {
  const path = recipePath(form.project, ports.home)
  const refused = refusalOf(form)
  if (refused !== null) return Effect.succeed({ ok: false, say: refused })
  // The check, the write and the registration are one critical section: see `exclusiveAdd`.
  return exclusiveAdd(form.project, checkAndWrite(form, ports, path), ports.locker).pipe(
    Effect.catch((busy) => Effect.succeed<Added>({ ok: false, say: busy.message })),
  )
}

/**
 * Another add of the same project holds the lock. A `SetupWriteError` so every
 * caller treats it as a refusal *before* any write: nothing is kept, and no
 * sentence may say a recipe is.
 */
export class AddBusy extends SetupWriteError {
  constructor(project: string) {
    super(`${project} is being added by another tab or process right now — wait for it, then reload`)
  }
}

/**
 * The critical section every add of a project runs in — the board's and
 * `lingtai add`'s both, because a lock only excludes writers that take it. It
 * is a file under `~/.lingtai/locks`, so it holds across processes; the
 * caller re-checks *already added* inside it, since the first add may have
 * finished between the caller's earlier read and the lock.
 */
export function exclusiveAdd<A, E>(
  project: string,
  body: Effect.Effect<A, E>,
  locker: Locker = createFileLocker(),
): Effect.Effect<A, E | AddBusy> {
  return Effect.acquireUseRelease(
    Effect.promise(() => locker.tryLock(`add:${project.toLowerCase()}`, 'lingtai-add')),
    (got): Effect.Effect<A, E | AddBusy> => (got.ok ? body : Effect.fail(new AddBusy(project))),
    (got) => (got.ok ? Effect.promise(() => got.lock.release()) : Effect.void),
  )
}

function checkAndWrite(form: SetupForm, ports: AddPorts, path: string): Effect.Effect<Added, never> {
  return Effect.tryPromise({ try: ports.projects, catch: reasonOf }).pipe(
    Effect.flatMap((projects) =>
      alreadyAdded(projects, form.project) !== undefined
        ? Effect.succeed<Added>({ ok: false, say: alreadyAddedSentence(form.project, ports.home) })
        : answersFor(form, ports).pipe(
            Effect.flatMap((answers) =>
              applySetup({ home: ports.home, files: ports.files }, answers, ports.register(form)),
            ),
            Effect.map((done): Added => ({ ok: true, project: form.project, path: done.path })),
            Effect.catch((err) =>
              Effect.succeed<Added>({
                ok: false,
                say: err instanceof SetupWriteError ? err.message : `${err.message}. ${keptSentence(path)}`,
              }),
            ),
          ),
    ),
    Effect.catch((reason) =>
      Effect.succeed<Added>({ ok: false, say: `could not read the projects: ${reasonOf(reason)}` }),
    ),
  )
}

/** The registration `lingtai add` makes, for the target the form was built for. */
export function liveRegister(target: SetupTarget, home?: string): AddPorts['register'] {
  if (target.kind === 'github') {
    return (form) => {
      const lines: string[] = []
      return addEffect({ slug: `${target.owner}/${target.repo}` }, (line) => lines.push(line)).pipe(
        Effect.mapError((e) => new Error(reasonOf(e))),
        Effect.flatMap((added) =>
          added.ok
            ? Effect.void
            : Effect.fail(new Error(lines.length > 0 ? lines.join('\n') : `${form.project} was not registered`)),
        ),
      )
    }
  }
  return (form) =>
    Effect.gen(function* () {
      const dir = target.path
      // The branch is made here, after the recipe is written: a refused write leaves none, and a retry finds it.
      const exists = yield* gitIn(dir, ['rev-parse', '--verify', `refs/heads/${form.base}^{commit}`])
      if (!exists.ok && form.base === LINGTAI_BASE) {
        const head = yield* gitIn(dir, ['symbolic-ref', '--short', '-q', 'HEAD'])
        if (!head.ok || head.out === '') {
          return yield* Effect.fail(
            new Error(`${dir} has no branch checked out, and ${LINGTAI_BASE} is made from the one that is`),
          )
        }
        const made = yield* gitIn(dir, ['branch', form.base, head.out])
        if (!made.ok) return yield* Effect.fail(new Error(`could not make ${form.base} from ${head.out} — ${made.out}`))
      } else if (!exists.ok) {
        return yield* Effect.fail(new Error(`${form.base} is not a branch in ${dir} — ${exists.out}`))
      }
      const tip = yield* gitIn(dir, ['rev-parse', '--verify', `refs/heads/${form.base}^{commit}`])
      if (!tip.ok) return yield* Effect.fail(new Error(`could not read ${form.base} in ${dir} — ${tip.out}`))
      const resolved = yield* Effect.tryPromise({
        try: () => resolveLocalRecipe(form.project, { home, signedIn: signedInHere }),
        catch: (e) => new Error(reasonOf(e)),
      })
      yield* addLocalEffect(
        {
          project: form.project,
          base: baseOf(resolved.recipe),
          configHash: resolved.configHash,
          fromSha: tip.out,
        },
        resolved,
      ).pipe(Effect.mapError((e) => new Error(reasonOf(e))))
    })
}

/** The live ports for one target. */
export function livePorts(target: SetupTarget, home?: string): AddPorts {
  return { home, projects: () => loadAllProjects(), register: liveRegister(target, home) }
}

/** The name a directory is added as: its top level's last segment (0104 §15). */
export const projectNameOf = (target: SetupTarget): string =>
  target.kind === 'github' ? target.repo : basename(target.path)

/** `resolveSource` over the preview's text, for the sentence that sits beside it. */
export function resolveText(text: string, project: string) {
  return resolveSource(text, recipePath(project), recipePath(project))
}
