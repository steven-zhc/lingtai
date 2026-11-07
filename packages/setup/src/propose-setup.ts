/**
 * `proposeSetup` (#974): everything step 2 shows, and everything `lingtai add`
 * would offer as a default, in one value. It writes nothing and appends no
 * event; the trial build is not part of it.
 *
 * **Each line says how it was learned.** `detected` was read off the
 * repository, GitHub, the log or this machine; `default` is what Lingtai
 * offers where there is nothing to read; `unknown` is a reader that failed,
 * with the reason. A default is never passed off as detected, and one failed
 * reader never fails the Proposal.
 */
import { SETUP_KINDS, type TicketSource } from '@lingtai/recipe'
import { Effect } from 'effect'

import { type DetectedSetup, detectSetup, type SetupReader } from './detect-setup.ts'
import { askRuntimes, type RuntimeFound } from './runtimes.ts'
import { liveHistory, ticketSourceFrom } from './ticket-source.ts'

export type Line<T> =
  | { state: 'detected'; value: T; from: string }
  | { state: 'default'; value: T }
  | { state: 'unknown'; reason: string }

/** What is being set up: a GitHub repository, or a directory on this machine. */
export type SetupTarget = { kind: 'github'; owner: string; repo: string } | { kind: 'local'; path: string }

export interface TicketsLine {
  source: TicketSource
  /** `owner/repo`, where the tickets are a GitHub repository's issues. */
  repository: string | null
}

export interface Proposal {
  target: SetupTarget
  /** The project name the log files its streams under. */
  project: string
  base: Line<string>
  /** Install, checks and the stack's notes, as `detectSetup` read them. */
  setup: Line<DetectedSetup>
  runtimes: Line<RuntimeFound[]>
  /** The runtime a cold reviewer would be, or `none`. */
  reviewer: Line<string>
  tickets: Line<TicketsLine>
  kinds: Line<readonly string[]>
  heldBy: Line<string>
  end: Line<readonly { name: string; when: string; close: boolean }[]>
  limits: Line<{ rounds: number; wall: string }>
  /** Whether a person approves the merge. */
  approve: Line<boolean>
}

/** The readers `proposeSetup` calls: Effect-returning, so a test hands in fakes. */
export interface ProposalReaders {
  /** The branch a pass is cut from. */
  base: (target: SetupTarget) => Effect.Effect<string | null, unknown>
  reader: (target: SetupTarget) => SetupReader
  runtimes: () => Effect.Effect<RuntimeFound[], unknown>
  /** `ticket-<project>-*` streams and `db ticket #n` rows already in the log. */
  history: (project: string) => Effect.Effect<readonly string[], unknown>
  /** `git remote get-url origin`: the URL, or null where there is no `origin`. */
  origin: (path: string) => Effect.Effect<string | null, unknown>
}

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** A reader's result as a line: whatever it threw becomes `unknown` with the reason. */
function read<T, U>(
  what: string,
  effect: Effect.Effect<T, unknown>,
  to: (value: T) => Line<U>,
): Effect.Effect<Line<U>> {
  return effect.pipe(
    Effect.map(to),
    Effect.catch((err) => Effect.succeed<Line<U>>({ state: 'unknown', reason: `${what}: ${reasonOf(err)}` })),
  )
}

/** `owner/repo` of a GitHub remote URL in any of its three forms, or null. */
export function githubRepositoryOf(url: string): string | null {
  const match = /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/git@|git@)github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(
    url.trim(),
  )
  return match === null ? null : `${match[1]}/${match[2]}`
}

export const projectOf = (target: SetupTarget): string =>
  target.kind === 'github'
    ? target.repo
    : (target.path
        .split('/')
        .filter((s) => s !== '')
        .pop() ?? target.path)

export function proposeSetup(target: SetupTarget, readers: ProposalReaders): Effect.Effect<Proposal> {
  return Effect.gen(function* () {
    const project = projectOf(target)
    const reader = readers.reader(target)

    const [base, setup, runtimes, tickets] = yield* Effect.all(
      [
        read('the default branch', readers.base(target), (value): Line<string> =>
          value === null
            ? { state: 'unknown', reason: 'the default branch: none could be read' }
            : { state: 'detected', value, from: target.kind === 'github' ? 'GitHub' : 'the checked-out branch' },
        ),
        read(
          'the repository',
          Effect.tryPromise(() => detectSetup(reader)),
          (value): Line<DetectedSetup> => ({
            state: 'detected',
            value,
            from: 'the repository root',
          }),
        ),
        read('the runtimes', readers.runtimes(), (value): Line<RuntimeFound[]> => ({
          state: 'detected',
          value,
          from: 'asking each runtime on this machine',
        })),
        ticketsLine(target, project, readers),
      ],
      { concurrency: 'unbounded' },
    )

    const reviewer: Line<string> =
      runtimes.state === 'unknown'
        ? { state: 'unknown', reason: runtimes.reason }
        : {
            state: 'detected',
            value: runtimes.value.find((r) => r.signedIn)?.id ?? 'none',
            from: 'the first runtime that is signed in',
          }

    return {
      target,
      project,
      base,
      setup,
      runtimes,
      reviewer,
      tickets,
      kinds: { state: 'default', value: SETUP_KINDS },
      heldBy: { state: 'default', value: 'agent:hold' },
      end: {
        state: 'default',
        value: [
          { name: 'close the ticket', when: 'landed', close: true },
          { name: 'close the ticket a person ended', when: 'closed', close: true },
        ],
      },
      limits: { state: 'default', value: { rounds: 2, wall: '2h' } },
      approve: { state: 'default', value: false },
    }
  })
}

function ticketsLine(target: SetupTarget, project: string, readers: ProposalReaders): Effect.Effect<Line<TicketsLine>> {
  return Effect.gen(function* () {
    const repository = target.kind === 'github' ? `${target.owner}/${target.repo}` : null
    const history = yield* Effect.result(readers.history(project))
    if (history._tag === 'Failure') {
      return { state: 'unknown', reason: `the log: ${reasonOf(history.failure)}` } satisfies Line<TicketsLine>
    }
    const found = history.success
    if (found.length > 0) {
      const source = ticketSourceFrom(null, found)
      return {
        state: 'detected',
        value: { source, repository: source === 'github' ? repository : null },
        from: `the log already has tickets for this project (${found.join(', ')})`,
      } satisfies Line<TicketsLine>
    }
    if (target.kind === 'github') {
      return {
        state: 'detected',
        value: { source: 'github', repository },
        from: 'this repository on GitHub',
      } satisfies Line<TicketsLine>
    }
    const origin = yield* Effect.result(readers.origin(target.path))
    if (origin._tag === 'Failure') {
      return { state: 'unknown', reason: `git remote: ${reasonOf(origin.failure)}` } satisfies Line<TicketsLine>
    }
    const slug = origin.success === null ? null : githubRepositoryOf(origin.success)
    return slug !== null
      ? ({
          state: 'detected',
          value: { source: 'github', repository: slug },
          from: `origin is ${slug} on GitHub`,
        } satisfies Line<TicketsLine>)
      : ({
          state: 'detected',
          value: { source: 'db', repository: null },
          from: origin.success === null ? 'no origin remote' : 'origin is not on GitHub',
        } satisfies Line<TicketsLine>)
  })
}

/** The live readers over this machine, for a local directory. A GitHub target's `base` and `reader` come from the caller (they need its reach). */
export const liveReaders = (
  over: Pick<ProposalReaders, 'base' | 'reader'>,
  gitOut: (cwd: string, args: string[]) => Promise<string | null>,
): ProposalReaders => ({
  ...over,
  runtimes: () => Effect.tryPromise(() => askRuntimes()),
  history: (project) => Effect.tryPromise(() => liveHistory(project)),
  origin: (path) => Effect.tryPromise(() => gitOut(path, ['remote', 'get-url', 'origin'])),
})
