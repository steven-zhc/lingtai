import { parseFindings, verdictFor } from '@lingtai/actions'
/**
 * **An agent resolves a PR's conflict, in rounds counted on the PR's own stream** (#1313, 0130 §6, 0108 §8).
 *
 * A conflicting merge in either of #1312's steps — `main` into the PR branch, or the PR branch back into
 * `branch.personal` — comes here instead of ending at once. A round is: the merge stood up in a throwaway worktree with
 * its markers left (`standMerge`), the recipe's `implement` agent briefed on what each side meant, the answer read off
 * the commit graph, `build`, and the recipe's `review` agent on `git show --remerge-diff` of the resolution. A refusal
 * of any of them is the next round, briefed with it.
 *
 * - **A round is counted when it starts and never refunded** (`SyncRoundStarted`, before the dispatch): 0108 §8 resets
 *   no counter inside its scope, not by a restart. The count is read from the log, never held in memory.
 * - **A lock stops a round before it starts and spends none** (0126 §6): this is new work.
 * - **A round runs outside any lane, and pushes nothing.** What comes of a resolution is the caller's: the sync step
 *   makes it the PR's `target` and `push` takes the lane's turn; the merge back pushes inside `branch.personal`'s turn.
 * - **The agent is dispatched unhooked**, as the cold reviewer is: the hook's socket appends `RunTouchedFile` and its
 *   siblings, which a `pr-` stream does not carry. The bound on the run is the runtime's own flags.
 * - **The answer is the graph**: `HEAD`'s parents are exactly `[start, commit]` and no merge is in progress. Prose is
 *   never read.
 */
import { DIFF_FLAGS, type ConflictEnd, type PayloadOf, prStream } from '@lingtai/domain'
import { parsePayload } from '@lingtai/domain'
import { conflictRoundsLeft } from '@lingtai/domain'
import { readPr, readPrDraft, recordSyncRoundStarted } from '@lingtai/project'
import { type Recipe, numericTurns, parseDuration } from '@lingtai/recipe'
import { Effect, Result } from 'effect'

import { type OursTicket, type Read, type TheirsCommit, prConflictBrief, prReviewBrief } from './pr-conflict-brief.ts'
import { asError, gitSaid } from './pr-git.ts'
import type { ConflictResolver, PrPorts } from './pr.ts'
import { recordPrompt } from './record-prompt.ts'

const short = (sha: string): string => sha.slice(0, 7)

/** What is being resolved: one commit merged into another, by the sync step or the merge back. */
export interface ConflictAsk {
  readonly project: string
  readonly n: number
  readonly merging: 'main' | 'back'
  /** The commit merged in: a `main` commit, or the PR's head. */
  readonly commit: string
  /** The commit it is merged into: the PR branch's start, or `branch.personal`'s head. */
  readonly start: string
  /** What conflicted when the merge was first tried; the round's own stood-up merge may name more. */
  readonly paths: readonly string[]
  /** The branch merged into, for what an agent and a person read. */
  readonly into: string
  /** What is merged in, for the same readers: `main` or the PR branch. */
  readonly from: string
  /** The subject the conductor writes on the resolution commit, so the merge back's lost-record search finds it. */
  readonly subject: string
  /** Where the build is recorded (`int-{project}-{base}`), as the sync's and the merge back's own are. */
  readonly buildBase: string
  readonly checkId: string
}

export type ResolveEnd =
  | { readonly kind: 'resolved'; readonly sha: string }
  | { readonly kind: 'spent'; readonly end: ConflictEnd }
  /** A lock stopped the next round before it began; nothing was spent by the stop. */
  | { readonly kind: 'locked'; readonly sentence: string; readonly end: ConflictEnd }
  | { readonly kind: 'unknown'; readonly why: string }

type Refusal = NonNullable<ConflictEnd['last']>
type Round = { readonly kind: 'passed'; readonly sha: string } | { readonly kind: 'refused'; readonly refusal: Refusal }

interface AgentEntry {
  readonly agent: PayloadOf<'RunSpent'>['runtime']
  readonly model?: string
  readonly name: string
}

/** The agent actions a recipe declares at a step, in order. A `run:` or a `human:` is not one. */
const agentsAt = (recipe: Recipe, step: 'implement' | 'review'): AgentEntry[] =>
  (recipe.steps[step] as readonly object[]).flatMap((action) =>
    'agent' in action && typeof action.agent === 'string'
      ? [
          {
            agent: action.agent as AgentEntry['agent'],
            ...('model' in action && typeof action.model === 'string' ? { model: action.model } : {}),
            name: 'name' in action && typeof action.name === 'string' ? action.name : step,
          },
        ]
      : [],
  )

/** One event appended to the PR's stream at the head it is at now; once more if another writer got there first. */
const appendOnPr = (
  ports: PrPorts,
  project: string,
  n: number,
  type: 'RunSpent' | 'StepEnded',
  data: unknown,
): Effect.Effect<void, Error> => {
  const stream = prStream(project, n)
  const once = Effect.tryPromise({
    try: async () => {
      const have = await ports.store.read(stream)
      await ports.store.append(stream, have.length, [{ type, actor: 'conductor', data: parsePayload(type, data) }])
    },
    catch: asError,
  })
  return once.pipe(Effect.catch(() => once))
}

/** What a failed read is told to the agent as: *could not be read*, with the cause. */
const read = <A>(effect: Effect.Effect<A, Error>): Effect.Effect<A | { readonly failed: string }> =>
  effect.pipe(Effect.catch((err: Error) => Effect.succeed({ failed: err.message })))

const failedRead = <T>(r: Read<T>): r is { readonly failed: string } => !Array.isArray(r)

/** The tickets whose own merge touched a conflicted path, with what each side did. Every read that fails is said. */
const oursOf = (
  ports: PrPorts,
  resolver: ConflictResolver,
  ask: ConflictAsk,
  paths: readonly string[],
): Effect.Effect<Read<OursTicket>, Error> =>
  Effect.gen(function* () {
    const state = yield* readPr(ask.project, ask.n, ports.store)
    // The merge back's ours are the tickets landed on `branch.personal` since the freeze: the draft, which holds
    // exactly the landed tickets no PR holds yet. The sync's are the ones this PR holds.
    const tickets =
      ask.merging === 'main'
        ? (state?.tickets ?? [])
        : (yield* readPrDraft(
            ask.project,
            yield* ports.recipe(ask.project),
            yield* ports.candidates(ask.project),
            ports.store,
          )).map((t) => ({ ticket: t.ticket, mergeCommit: t.mergeCommit, title: t.title }))
    const found: OursTicket[] = []
    for (const t of tickets) {
      const args = ['diff', '--name-only', '-z', `${t.mergeCommit}^1`, t.mergeCommit] as const
      const touched = yield* ports.git(ask.project, args)
      if (touched.code !== 0) return yield* Effect.fail(new Error(gitSaid(args, touched)))
      const names = touched.stdout.split('\0').filter((p) => p !== '')
      const both = paths.filter((p) => names.includes(p))
      if (both.length === 0) continue
      const body = yield* resolver.ticketBody(ask.project, t.ticket).pipe(
        Effect.map((text): string | { readonly failed: string } => text),
        Effect.catch((err: Error) => Effect.succeed({ failed: err.message })),
      )
      found.push({ number: t.ticket, title: t.title, mergeCommit: t.mergeCommit, body, touched: both })
    }
    return found
  })

/** The commits on the other side that touched a conflicted path: `git log start..commit -- paths`. */
const theirsOf = (
  ports: PrPorts,
  ask: ConflictAsk,
  paths: readonly string[],
): Effect.Effect<Read<TheirsCommit>, Error> =>
  Effect.gen(function* () {
    const args = [
      'log',
      '--no-color',
      '--no-show-signature',
      '--format=%H%x00%an%x00%s%x00',
      `${ask.start}..${ask.commit}`,
      '--',
      ...paths,
    ] as const
    const answer = yield* ports.git(ask.project, args)
    if (answer.code !== 0) return yield* Effect.fail(new Error(gitSaid(args, answer)))
    const fields = answer.stdout.split('\0').map((f) => f.replace(/^\n+/, ''))
    const commits: TheirsCommit[] = []
    for (let i = 0; i + 2 < fields.length; i += 3) {
      const [sha, author, subject] = [fields[i]!, fields[i + 1]!, fields[i + 2]!]
      if (sha !== '') commits.push({ sha, author, subject })
    }
    return commits
  })

/** The wait or the failure a person reads when the rounds are spent: everything needed to choose (#1314 reads it). */
const endOf = (
  ask: ConflictAsk,
  paths: readonly string[],
  ours: Read<OursTicket>,
  theirs: Read<TheirsCommit>,
  roundsUsed: number,
  last: Refusal | null,
): ConflictEnd => ({
  merging: ask.merging,
  commit: ask.commit,
  paths: [...paths],
  ours: failedRead(ours) ? [] : ours.map((t) => ({ number: t.number, title: t.title, mergeCommit: t.mergeCommit })),
  theirs: failedRead(theirs) ? [] : theirs.map((c) => ({ sha: c.sha, author: c.author, subject: c.subject })),
  roundsUsed,
  last,
})

/**
 * Resolves the conflict in rounds until one passes, the rounds are spent, a lock stops the next, or something could not be
 * told. Fails only where a read of the log failed: *unknown is not zero* — no round starts on a count that could not be read.
 */
export const resolveRounds = (
  ports: PrPorts,
  resolver: ConflictResolver,
  ask: ConflictAsk,
): Effect.Effect<ResolveEnd, Error> =>
  Effect.gen(function* () {
    const { project, n } = ask
    const stream = prStream(project, n)
    const recipe = yield* ports.recipe(project)
    const implement = agentsAt(recipe, 'implement')[0] ?? null
    const reviewers = agentsAt(recipe, 'review')
    const bound = recipe.runtime.limits.attempt.conflictResolutions
    const limits = recipe.runtime.limits.run
    const diffBytes = recipe.runtime.budget.diff

    let last: Refusal | null = null
    let paths: readonly string[] = ask.paths
    let sides: { ours: Read<OursTicket>; theirs: Read<TheirsCommit> } | null = null
    const sidesNow = Effect.gen(function* () {
      if (sides === null) {
        sides = {
          ours: yield* read(oursOf(ports, resolver, ask, paths)),
          theirs: yield* read(theirsOf(ports, ask, paths)),
        }
      }
      return sides
    })
    const spent = (used: number) =>
      sidesNow.pipe(
        Effect.map((s) => ({ kind: 'spent', end: endOf(ask, paths, s.ours, s.theirs, used, last) }) as const),
      )

    const oneRound = (round: number): Effect.Effect<Round | ResolveEnd, Error> =>
      Effect.gen(function* () {
        if (implement === null) return yield* Effect.fail(new Error('no agent at implement'))
        yield* ports.sweep(project)
        const name = `${ask.merging === 'main' ? 'pr-sync' : 'pr-back'}-${n}-${Date.now()}`
        const stood = yield* resolver.standMerge(project, { name, at: ask.start, theirs: ask.commit })
        if (stood.kind === 'failed') {
          return { kind: 'unknown', why: `the merge could not be stood up: ${stood.text}` } as const
        }
        if (stood.paths.length === 0) {
          return {
            kind: 'unknown',
            why: `${ask.from} no longer conflicts with ${ask.into} at ${short(ask.start)}`,
          } as const
        }
        paths = stood.paths
        const cwd = stood.cwd
        const { ours, theirs } = yield* sidesNow
        const brief = {
          merging: ask.merging,
          into: ask.into,
          from: ask.from,
          commit: ask.commit,
          paths,
          ours,
          theirs,
          round,
          bound,
          refusal: last,
        }
        const runId = (purpose: 'resolve' | 'review') =>
          `pr-${project}-${n}:${purpose}:${ask.merging}:${short(ask.commit)}:${round}`
        const spentFor = (purpose: 'resolve' | 'review') =>
          ({ _tag: 'Pr', purpose, merging: ask.merging, commit: ask.commit, round }) as const

        /** One paid call: its prompt on the log first, then the run, then its `RunSpent`. */
        const paid = (purpose: 'resolve' | 'review', agent: AgentEntry, parts: readonly string[]) =>
          Effect.gen(function* () {
            const prompt = parts.join('')
            const version = yield* resolver.runtimeVersion(project, agent.agent).pipe(Effect.orElseSucceed(() => null))
            yield* Effect.promise(() =>
              recordPrompt(
                ports.store,
                stream,
                {
                  for: spentFor(purpose),
                  promptVersion: `pr-${purpose}@${prompt.length}`,
                  runtimeVersion: version,
                  prompt,
                },
                ports.log,
              ),
            )
            const outcome = yield* resolver
              .dispatch(project, {
                runtime: agent.agent,
                ...(agent.model === undefined ? {} : { model: agent.model }),
                cwd,
                prompt,
                runId: runId(purpose),
                limits: {
                  ...(numericTurns(limits.turns) === undefined ? {} : { turns: numericTurns(limits.turns) }),
                  wallMs: parseDuration(limits.wall),
                  ...(limits.usd === undefined ? {} : { usd: limits.usd }),
                },
              })
              .pipe(Effect.result)
            // A run that threw returned no outcome, and a killed process has nothing to record (0110 §2).
            if (Result.isFailure(outcome)) {
              return { text: null, failure: { kind: 'crash', detail: outcome.failure.message } }
            }
            yield* appendOnPr(ports, project, n, 'RunSpent', {
              for: spentFor(purpose),
              runtime: agent.agent,
              turns: outcome.success.turns,
              durationMs: outcome.success.durationMs,
              costUsd: outcome.success.costUsd,
              usage: outcome.success.usage ?? [],
            })
            return outcome.success
          })

        const answered = yield* paid('resolve', implement, prConflictBrief(brief))
        const refuse = (step: Refusal['step'], said: string): Round => ({ kind: 'refused', refusal: { step, said } })
        if (answered.failure !== null) {
          return refuse('answer', `the agent did not finish (${answered.failure.kind}): ${answered.failure.detail}`)
        }

        // The answer is the commit graph, read before anything is written to it.
        const inProgress = yield* resolver.gitIn(cwd, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])
        if (inProgress.code === 0) return refuse('answer', 'the merge is still in progress: nothing was committed')
        const parents = yield* resolver.gitIn(cwd, ['rev-list', '--parents', '-n', '1', 'HEAD'])
        if (parents.code !== 0) return refuse('answer', `the commit could not be read: ${parents.stdout.trim()}`)
        const [head, ...above] = parents.stdout.trim().split(/\s+/)
        if (above.length !== 2 || above[0] !== ask.start || above[1] !== ask.commit) {
          return refuse(
            'answer',
            `the commit has parents [${above.map(short).join(', ')}]; it must have exactly [${short(ask.start)}, ${short(ask.commit)}]`,
          )
        }
        void head
        // The subject is the conductor's, not the agent's: the merge back's lost-record search finds a push by it.
        const amend = ['commit', '--amend', '--only', '--no-verify', '-m', ask.subject] as const
        const reworded = yield* resolver.gitIn(cwd, amend)
        if (reworded.code !== 0) return refuse('answer', `the commit could not be reworded: ${reworded.stdout.trim()}`)
        const resolved = yield* resolver.gitIn(cwd, ['rev-parse', 'HEAD'])
        const sha = resolved.stdout.trim()
        if (resolved.code !== 0 || sha === '') return refuse('answer', 'the resolution commit could not be read')

        const built = yield* ports.build(project, { sha, base: ask.buildBase, checkId: ask.checkId })
        if (built.kind === 'red') {
          return refuse('build', `\`${built.command}\` fails on ${short(sha)}:\n${built.evidence}`)
        }
        if (built.kind === 'unknown') {
          return { kind: 'unknown', why: `the build of ${short(sha)} could not be told: ${built.why}` } as const
        }

        // A pause in the middle of a round must not buy the review: the round is spent, the next is not started.
        const stopped = yield* resolver.locked(project)
        if (stopped !== null) {
          const s = yield* sidesNow
          const used = (yield* readPr(project, n, ports.store))?.rounds.filter(
            (r) => r.merging === ask.merging && r.commit === ask.commit,
          ).length
          return {
            kind: 'locked',
            sentence: stopped,
            end: endOf(ask, paths, s.ours, s.theirs, used ?? round, last),
          } as const
        }

        const shown = yield* resolver.gitIn(cwd, ['show', '--remerge-diff', ...DIFF_FLAGS, '--format=', sha])
        if (reviewers.length > 0 && shown.code !== 0) {
          return refuse('review', `the resolution's diff could not be produced: ${shown.stdout.trim()}`)
        }
        const clipped = shown.stdout.length > diffBytes
        const diff = clipped ? shown.stdout.slice(0, diffBytes) : shown.stdout
        const actions: PayloadOf<'StepEnded'>['outcome']['actions'] = []
        const blocking: string[] = []
        for (const reviewer of reviewers) {
          const reviewed = yield* paid('review', reviewer, prReviewBrief(brief, diff, clipped))
          const parsed = reviewed.failure === null ? parseFindings(reviewed.text) : null
          const base = { plugin: 'agent', name: reviewer.name, onSha: sha, evidence: '', yields: 'verdict' } as const
          if (reviewed.failure !== null) {
            const cause = (['timeout', 'aborted', 'out-of-turns', 'out-of-usd'] as const).find(
              (c) => c === reviewed.failure?.kind,
            )
            actions.push({
              ...base,
              evidence: reviewed.failure.detail,
              result: { _tag: 'Interrupted', cause: cause ?? 'crash' },
            })
            blocking.push(`the reviewer did not finish (${reviewed.failure.kind}): ${reviewed.failure.detail}`)
          } else if (parsed === null || !parsed.parsed) {
            actions.push({ ...base, result: { _tag: 'AnswerUnreadable', raw: reviewed.text ?? '' } })
            blocking.push('the reviewer’s answer could not be read, so the resolution is not reviewed')
          } else {
            const verdict = verdictFor(parsed.findings)
            actions.push({
              ...base,
              result: {
                _tag: 'Completed',
                assessment: { verdict: verdict === 'passed' ? 'accepted' : 'refused', findings: [...parsed.findings] },
              },
            })
            if (verdict === 'failed') {
              for (const f of parsed.findings.filter((f) => f.severity !== 'minor')) {
                blocking.push(
                  `${f.file}${f.line === null ? '' : `:${f.line}`} [${f.severity}] ${f.claim} — ${f.failureScenario}`,
                )
              }
            }
          }
        }
        if (reviewers.length > 0) {
          // On the PR's stream with the run id the review's spend names, so `findingsRaisedOf` reads its minors unchanged.
          yield* appendOnPr(ports, project, n, 'StepEnded', {
            runId: runId('review'),
            outcome: { step: 'review', round, actions },
          })
        }
        if (blocking.length > 0) return refuse('review', blocking.join('\n'))
        return { kind: 'passed', sha } as const
      })

    for (;;) {
      const state = yield* readPr(project, n, ports.store)
      if (state === null) return yield* Effect.fail(new Error(`${stream} has no events`))
      const { used, left, next } = conflictRoundsLeft(state, ask.merging, ask.commit, bound)
      if (implement === null || left === 0) return yield* spent(used)

      const lock = yield* resolver.locked(project)
      if (lock !== null) {
        const s = yield* sidesNow
        return { kind: 'locked', sentence: lock, end: endOf(ask, paths, s.ours, s.theirs, used, last) } as const
      }

      // Before the dispatch, so a crash leaves the round spent. A round another appender counted first is read again.
      const counted = yield* recordSyncRoundStarted(
        project,
        n,
        { merging: ask.merging, commit: ask.commit, start: ask.start, round: next },
        ports.store,
      )
      if (!counted) continue

      const done = yield* oneRound(next)
      if (done.kind === 'passed') return { kind: 'resolved', sha: done.sha }
      if (done.kind === 'refused') {
        last = done.refusal
        continue
      }
      return done
    }
  })
