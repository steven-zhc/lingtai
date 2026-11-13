/**
 * `proposeSetup`: every line step 2 of "add a repository" shows, and every
 * default `lingtai add` would offer, read once into one value (#974).
 *
 * **Reads, writes nothing** — `applySetup` (#968) writes. **Every line is two
 * sided** (`Line`): a reader that failed is `known: false` with its reason and
 * the default `lingtai add` would offer, never that default passed off as
 * detected. **The trial build is not called here**; `lingtai add` keeps it.
 *
 * Its own file because `detect-setup.ts` is pure and this is not: the readers
 * it is handed do IO. `import type` only from a client component.
 */
import { everyRuntime } from '@lingtai/agent'
import { RuntimeId } from '@lingtai/domain'
import { SETUP_KINDS } from '@lingtai/recipe'
import { Effect } from 'effect'

import { detectSetupEffect, type DetectedSetup, type SetupReader } from './detect-setup.ts'
import { portCause } from './port-cause.ts'
import { remedyFor, runtimeStateSentence, type RuntimeFound } from './runtimes.ts'
import { githubSlugOfRemote, ticketSourceOf, type TicketSourceName } from './ticket-source.ts'

export type Line<T> = { known: true; value: T; because: string } | { known: false; reason: string; default: T }

export type SetupTarget = { kind: 'github'; owner: string; repo: string } | { kind: 'local'; path: string }

export interface ProposalRuntime extends RuntimeFound {
  /** Empty where signed in; otherwise the sentence and what to do about it. */
  remedy: string | null
}

/** The ticket source, and the GitHub repository whose issues it reads where it is `github`. */
export interface TicketsProposal {
  source: TicketSourceName
  repository: { owner: string; repo: string } | null
}

export interface Proposal {
  target: SetupTarget
  base: Line<string | null>
  install: Line<string | null>
  checks: Line<{ name: string; run: string }[]>
  /** What detection said about the stack: its notes and the scripts it skipped. */
  stack: Line<{ notes: string[]; skipped: DetectedSetup['skipped'] }>
  /** The whole detection, so a question can reuse it rather than read the repository again. */
  detected: Line<DetectedSetup>
  runtimes: Line<ProposalRuntime[]>
  writer: Line<string | null>
  reviewer: Line<string | null>
  tickets: Line<TicketsProposal>
  kinds: Line<string[]>
  /** The label a new recipe excludes: null, because `source.exclude` defaults to `[]`. */
  heldBy: Line<string | null>
  end: Line<string[]>
  limits: Line<{ rounds: number; wall: string; turns: number | 'unbounded' }>
  /** Always false: `proposed: []` (#964 decision 5). A person approving the merge is something chosen. */
  personApprovesMerge: boolean
}

/** What a proposal reads. Every one is injected, so each is a fake in a test. */
export interface ProposalReaders {
  setupReader: SetupReader
  /** The default branch; for a local path, the one the caller already worked out. */
  defaultBranch: () => Effect.Effect<string | null, unknown>
  runtimes: () => Effect.Effect<readonly RuntimeFound[], unknown>
  /** `ticket-<project>-*` streams already in the log — the caller's `liveHistory`. */
  history: (project: string) => Effect.Effect<readonly string[], unknown>
  /** `git remote get-url origin` of a local path: null where there is no `origin`. */
  origin: (path: string) => Effect.Effect<string | null, unknown>
}

/** A new recipe excludes no label: `source.exclude` defaults to `[]`, so nothing is held until somebody says so. */
export const DEFAULT_HELD_BY = null
/** What `lingtai add` seeds at `steps.end` for a new GitHub project (`add-github.ts`); a local project seeds none. */
export const DEFAULT_END = ['close the ticket when landed', 'close the ticket when a person ended it']
/** `runtime.limits`' schema default (`packages/recipe/src/recipe.ts`, the `limits` default). */
export const DEFAULT_LIMITS = { turns: 300, wall: '2h', rounds: 2 } as const

/** `askAgents` writes `turns: unbounded` for a writer whose runtime does not enforce a turn count (#547). */
function turnsFor(writer: string | null): number | 'unbounded' {
  const capabilities = everyRuntime().find((r) => r.capabilities.id === writer)?.capabilities
  return capabilities !== undefined && !capabilities.enforces.includes('turns') ? 'unbounded' : DEFAULT_LIMITS.turns
}

/**
 * The writer and reviewer `askAgents` offers as defaults: the first signed-in
 * runtime in the enum's order, and a different signed-in one where there is
 * one (doc/design/398.md §1). `askAgents` calls this, so the rule is not
 * written twice.
 */
export function defaultAgents(signedIn: readonly string[]): { writer: string | null; reviewer: string | null } {
  const writer = RuntimeId.options.find((id) => signedIn.includes(id)) ?? null
  if (writer === null) return { writer: null, reviewer: null }
  return { writer, reviewer: signedIn.find((id) => id !== writer) ?? writer }
}

const reasonOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

type Settled<T> = { ok: true; value: T } | { ok: false; reason: string }

/** A reader as an Effect that cannot fail: the failure, or a defect, is a value. */
const settle = <T>(read: Effect.Effect<T, unknown>): Effect.Effect<Settled<T>, never> =>
  portCause(read).pipe(
    Effect.match({
      onSuccess: (value): Settled<T> => ({ ok: true, value }),
      onFailure: (e): Settled<T> => ({ ok: false, reason: reasonOf(e) }),
    }),
  )

/** One reader as an Effect that can only succeed: a failure is a `known: false` line. */
const attempt = <T, A>(
  read: Effect.Effect<T, unknown>,
  ok: (value: T) => Line<A>,
  fallback: A,
): Effect.Effect<Line<A>, never> =>
  portCause(read).pipe(
    Effect.match({
      onSuccess: ok,
      onFailure: (e): Line<A> => ({ known: false, reason: reasonOf(e), default: fallback }),
    }),
  )

/** A `SetupReader` that remembers the first read that failed, since `detectSetup` swallows them. */
function watched(reader: SetupReader): { reader: SetupReader; failure: () => string | null } {
  let failed: string | null = null
  const present = new Set<string>()
  const note = (e: unknown) =>
    Effect.sync(() => {
      failed ??= reasonOf(e)
    })
  return {
    reader: {
      has: (path) =>
        portCause(reader.has(path)).pipe(
          Effect.tap((there) =>
            Effect.sync(() => {
              if (there) present.add(path)
            }),
          ),
          Effect.tapError(note),
        ),
      // A reader answers `null` for "could not get this content", so a file
      // that `has` just found and `read` cannot return is a failed read.
      read: (path) =>
        portCause(reader.read(path)).pipe(
          Effect.tap((text) =>
            Effect.sync(() => {
              if (text === null && present.has(path)) failed ??= `${path} exists but could not be read`
            }),
          ),
          Effect.tapError(note),
        ),
    },
    failure: () => failed,
  }
}

export function proposeSetup(target: SetupTarget, readers: ProposalReaders): Effect.Effect<Proposal, never> {
  return Effect.gen(function* () {
    const project = target.kind === 'github' ? target.repo : (target.path.split('/').filter(Boolean).at(-1) ?? '')

    const watch = watched(readers.setupReader)
    const detected = yield* Effect.result(detectSetupEffect(watch.reader))
    const readFailure = detected._tag === 'Success' ? watch.failure() : detected.failure.message
    const found: DetectedSetup =
      detected._tag === 'Success' ? detected.success : { install: null, build: [], skipped: [], notes: [] }
    const fromRepo = <A>(value: A, because: string, fallback: A): Line<A> =>
      readFailure === null
        ? { known: true, value, because }
        : { known: false, reason: `the repository could not be read: ${readFailure}`, default: fallback }

    const base = yield* attempt(
      readers.defaultBranch(),
      (b): Line<string | null> =>
        b === null
          ? { known: false, reason: 'the default branch could not be determined', default: null }
          : { known: true, value: b, because: 'the default branch' },
      null,
    )

    const probed = yield* settle(readers.runtimes())
    const foundRuntimes = probed.ok ? probed.value : []
    const signedIn = foundRuntimes.filter((r) => r.signedIn).map((r) => r.id)
    const agents = defaultAgents(signedIn)
    const withRemedy: ProposalRuntime[] = foundRuntimes.map((r) => ({
      ...r,
      remedy: r.signedIn ? null : `${runtimeStateSentence(r.id, r.state, r.detail)} — ${remedyFor(r.state)}`,
    }))
    // A probe that did not start (or answered something unrecognised) has not
    // said whether the runtime is signed in — that is unknown, not signed out.
    const unsure = foundRuntimes.filter((r) => r.state === 'did-not-start' || r.state === undefined)
    const unsureReason =
      unsure.length === 0 ? null : unsure.map((r) => runtimeStateSentence(r.id, r.state, r.detail)).join('; ')
    const runtimes: Line<ProposalRuntime[]> = !probed.ok
      ? { known: false, reason: probed.reason, default: [] }
      : unsureReason !== null
        ? { known: false, reason: unsureReason, default: withRemedy }
        : {
            known: true,
            because: signedIn.length === 0 ? 'no runtime is signed in' : `${signedIn.join(', ')} signed in`,
            value: withRemedy,
          }
    const fromRuntimes = (value: string | null): Line<string | null> =>
      !probed.ok
        ? { known: false, reason: probed.reason, default: null }
        : unsureReason !== null
          ? { known: false, reason: unsureReason, default: value }
          : { known: true, value, because: value === null ? 'no runtime is signed in' : 'a signed-in runtime' }

    // History overrides `origin`: another source would number its own tickets
    // into the same streams (`DIFFERENT_SOURCE_CLASH`, apps/cli/src/source.ts).
    const history = yield* settle(readers.history(project))
    const origin = target.kind === 'local' ? yield* settle(readers.origin(target.path)) : null
    const repository =
      target.kind === 'github'
        ? { owner: target.owner, repo: target.repo }
        : origin !== null && origin.ok && origin.value !== null
          ? githubSlugOfRemote(origin.value)
          : null
    const tickets: Line<TicketsProposal> = !history.ok
      ? { known: false, reason: history.reason, default: { source: 'db', repository: null } }
      : origin !== null && !origin.ok
        ? {
            known: false,
            reason: origin.reason,
            default: {
              source: history.value.length > 0 ? ticketSourceOf(null, history.value) : 'db',
              repository: null,
            },
          }
        : history.value.length > 0
          ? {
              known: true,
              value: { source: ticketSourceOf(null, history.value), repository },
              because: 'kept: the log already has tickets for this project',
            }
          : repository !== null
            ? { known: true, value: { source: 'github', repository }, because: 'the repository is on GitHub' }
            : {
                known: true,
                value: { source: 'db', repository: null },
                because: 'no GitHub origin, so Lingtai keeps its own tickets',
              }

    const checks = found.build.map(({ name, run }) => ({ name, run }))
    return {
      target,
      base,
      install: fromRepo(found.install?.run ?? null, found.install?.because ?? 'nothing detected', null),
      checks: fromRepo(checks, checks.length === 0 ? 'nothing detected' : 'detected from the repository', []),
      stack: fromRepo({ notes: found.notes, skipped: found.skipped }, 'detected from the repository', {
        notes: [],
        skipped: [],
      }),
      detected: fromRepo(found, 'detected from the repository', { install: null, build: [], skipped: [], notes: [] }),
      runtimes,
      writer: fromRuntimes(agents.writer),
      reviewer: fromRuntimes(agents.reviewer),
      tickets,
      kinds: { known: true, value: [...SETUP_KINDS], because: 'the default, in priority order' },
      heldBy: { known: true, value: DEFAULT_HELD_BY, because: 'a new recipe excludes no label' },
      end:
        target.kind === 'github'
          ? { known: true, value: DEFAULT_END, because: 'what a new GitHub project is seeded with' }
          : { known: true, value: [], because: 'a local project is seeded with no end actions' },
      limits: {
        known: true,
        value: { ...DEFAULT_LIMITS, turns: turnsFor(agents.writer) },
        because: "the recipe's default, with no turn ceiling for a runtime that cannot enforce one",
      },
      personApprovesMerge: false,
    }
  })
}
