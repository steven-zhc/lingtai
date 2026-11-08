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
 * **Written with `.then` chains, not `async`** — this package is at its
 * `effect-ratchet` baseline.
 */
import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'

import type { ProjectState } from '@lingtai/domain'
import { githubApp, githubClientAuth } from '@lingtai/env'
import { createGitHubClient, GitHubError, installationForRepo, type GitHubClient } from '@lingtai/github'
import { baseOf, type RecipeFiles, recipePath, resolveLocalRecipe, resolveSource } from '@lingtai/recipe'
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

import { add, addLocal } from './onboard.ts'
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
      Effect.promise(() =>
        stat(path).then(
          (s) => (s.isDirectory() ? ('directory' as const) : ('file' as const)),
          () => 'missing' as const,
        ),
      ),
    git: gitIn,
  })
}

/** A client over a GitHub repository: the saved `gh` login, or the App's installation on it. */
function githubClientFor(owner: string, repo: string): Promise<GitHubClient> {
  const auth = githubClientAuth()
  if ('kind' in auth && auth.kind === 'gh') return createGitHubClient({ auth: { kind: 'gh' }, owner, repo })
  const app = githubApp()
  return installationForRepo(app, owner, repo).then((installation) =>
    createGitHubClient({ auth: app, owner, repo, installation }),
  )
}

/** Files in a checkout on this machine. */
const diskReader = (dir: string): SetupReader => ({
  has: (path) =>
    stat(join(dir, path)).then(
      () => true,
      () => false,
    ),
  read: (path) => readFile(join(dir, path), 'utf8').catch(() => null),
})

/** Files in a GitHub repository at its default branch; a 404 is an absence, anything else is "could not tell". */
function githubReader(client: Promise<GitHubClient>, owner: string, repo: string): SetupReader {
  const refOf = client.then((c) => c.defaultBranch())
  return {
    has: (path) =>
      Promise.all([client, refOf]).then(([c, ref]) =>
        c.request('GET', `/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`).then(
          () => true,
          (err) => {
            if (err instanceof GitHubError && err.status === 404) return false
            throw err
          },
        ),
      ),
    read: (path) =>
      Promise.all([client, refOf]).then(
        ([c, ref]) => c.fileAt(path, ref).catch(() => null),
        () => null,
      ),
  }
}

/** The readers a proposal reads through, for one target. */
export function liveReaders(target: SetupTarget): ProposalReaders {
  if (target.kind === 'github') {
    const client = githubClientFor(target.owner, target.repo)
    // A rejected promise nobody awaited yet must not surface as unhandled.
    client.catch(() => undefined)
    return {
      setupReader: githubReader(client, target.owner, target.repo),
      defaultBranch: () => client.then((c) => c.defaultBranch()),
      runtimes: askRuntimes,
      history: liveHistory,
      origin: () => Promise.resolve(null),
    }
  }
  return {
    setupReader: diskReader(target.path),
    // A directory lands on `lingtai-base`, made from the branch it is on (0104 §15), not on the branch checked out.
    defaultBranch: () => Promise.resolve(LINGTAI_BASE),
    runtimes: askRuntimes,
    history: liveHistory,
    origin: (path) =>
      promisify(execFile)('git', ['remote', 'get-url', 'origin'], { cwd: path }).then(
        (r) => (r.stdout.trim() === '' ? null : r.stdout.trim()),
        () => null,
      ),
  }
}

/** Every line step 2 shows, read once; a failed read is a `known: false` line and not an error. */
export function proposalFor(
  target: SetupTarget,
  readers: ProposalReaders = liveReaders(target),
): Effect.Effect<Proposal, never> {
  return proposeSetup(target, readers)
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
  return previewSetup(ports, setupAnswers(form)).pipe(
    Effect.match({ onSuccess: (text) => ({ text }), onFailure: (err) => ({ refused: err.message }) }),
  )
}

export interface AddPorts {
  home?: string
  files?: RecipeFiles
  /** Every project with a stream: the reads `lingtai add` refuses an add from. */
  projects: () => Promise<readonly ProjectState[]>
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
  return Effect.tryPromise({ try: ports.projects, catch: reasonOf }).pipe(
    Effect.flatMap((projects) =>
      alreadyAdded(projects, form.project) !== undefined
        ? Effect.succeed<Added>({ ok: false, say: alreadyAddedSentence(form.project, ports.home) })
        : applySetup({ home: ports.home, files: ports.files }, setupAnswers(form), ports.register(form)).pipe(
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
      return Effect.tryPromise({
        try: () => add({ slug: `${target.owner}/${target.repo}` }, (line) => lines.push(line)),
        catch: reasonOf,
      }).pipe(
        Effect.mapError((reason) => new Error(reason)),
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
      yield* Effect.tryPromise({
        try: () =>
          resolveLocalRecipe(form.project, { home, signedIn: signedInHere }).then((resolved) =>
            addLocal(
              {
                project: form.project,
                base: baseOf(resolved.recipe),
                configHash: resolved.configHash,
                fromSha: tip.out,
              },
              resolved,
            ),
          ),
        catch: (e) => new Error(reasonOf(e)),
      })
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
