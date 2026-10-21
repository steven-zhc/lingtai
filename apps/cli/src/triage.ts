/**
 * `waitTriage`: one held wait, triaged — the `apps/cli` half of `#428`.
 *
 * `packages/conductor/src/triage.ts` is pure (its own header: *"no runtime, no
 * mirror, no store, no clock"*) and stops at `triageBrief`/`parseTriage`. This
 * is the caller that module asks for: it reads the ticket's stream, appends
 * `TriageStarted`, gathers the evidence, dispatches the agent under
 * Discussion's containment, and appends one `WaitTriaged`.
 *
 * **Every port, injected** — the store, the runtime, the mirror reads, the
 * issue fetch, the base branch, the containment and the clock — so the unit
 * test needs none of the real ones. `daemonTriagePorts` wires the production
 * ports for the daemon in this file.
 */
import { createRuntime, type Runtime, type RunOutcome } from '@lingtai/agent'
import { runnableEnv } from '@lingtai/agent-env'
import { readingFor } from '@lingtai/conductor/discuss'
import { projectClient } from '@lingtai/conductor/filter'
import { currentRecipe, loadProject } from '@lingtai/conductor/projects'
import {
  MAX_READ_ROUNDS,
  parseTriage,
  triageBrief,
  type ReadableRef,
  type TriageEvidence,
} from '@lingtai/conductor/triage'
import {
  parsePayload,
  parseTicketStream,
  reduceTicket,
  triageFactsOf,
  TRIAGE_TEXT_MAX,
  type Envelope,
  type PayloadOf,
  type WaitId,
} from '@lingtai/domain'
import { triageStatus, type TriageResult, type WaitReason } from '@lingtai/domain/wait'
import { ConcurrencyError, eventStore, type EventStore } from '@lingtai/event-store'
import { triageCallFor, type DiscussAgent, type Triage } from '@lingtai/recipe'
import { diffStatAt, listAt, readAt, refSha } from '@lingtai/repo'

import { headOf, prepare } from './discuss.ts'

/** One queue for this daemon process; the key stays present until its worker settles. */
const queued = new Set<string>()
let tail: Promise<void> = Promise.resolve()

export function enqueueTriage(
  key: { ticketId: string; waitId: WaitId },
  run: () => Promise<unknown>,
  log: (line: string) => void = console.error,
): boolean {
  const id = JSON.stringify([key.ticketId, key.waitId])
  if (queued.has(id)) return false
  queued.add(id)
  tail = tail.then(async () => {
    try {
      await run()
    } catch (err) {
      log(`triage ${key.waitId}: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      queued.delete(id)
    }
  })
  return true
}

export interface TriageTriggerPorts {
  store: Pick<EventStore, 'read'>
  triageFor(project: string): Promise<Triage | null>
  daemonStartedAt: Date | null
  run(request: WaitTriageRequest): Promise<unknown>
  log?: (line: string) => void
}

function currentWait(events: readonly Envelope[], waitId: WaitId): boolean {
  const lifecycle = reduceTicket(events).lifecycle
  return lifecycle.status === 'blocked' && lifecycle.waitId === waitId
}

/** Hand over only a current, queued wait. The returned promise never waits for its worker. */
export async function onWaitStarted(event: Envelope, deps: TriageTriggerPorts): Promise<void> {
  if (event.type !== 'WaitStarted') return
  const parsed = parseTicketStream(event.streamId)
  if (parsed === null) return
  const triage = await deps.triageFor(parsed.project).catch(() => null)
  const events = await deps.store.read(event.streamId)
  const { waitId, reason } = event.data as PayloadOf<'WaitStarted'>
  if (!currentWait(events, waitId)) return
  const context = { declared: triage !== null, daemonStartedAt: deps.daemonStartedAt }
  if (triageStatus(reason, triageFactsOf(events, waitId), context)._tag !== 'Queued' || triage === null) return
  enqueueTriage(
    { ticketId: event.streamId, waitId },
    async () => {
      const latest = await deps.store.read(event.streamId)
      if (!currentWait(latest, waitId)) return
      if (triageStatus(reason, triageFactsOf(latest, waitId), context)._tag !== 'Queued') return
      await deps.run({ ticketId: event.streamId, waitId, reason, triage })
    },
    deps.log,
  )
}

/** The daemon's real ports. A recipe that cannot resolve leaves triage undeclared. */
export function daemonTriagePorts(daemonStartedAt: Date | null, log: (line: string) => void): TriageTriggerPorts {
  return {
    store: eventStore,
    daemonStartedAt,
    log,
    triageFor: async (project) => {
      const state = await loadProject(project)
      return state === null ? null : ((await currentRecipe(state)).recipe.triage ?? null)
    },
    run: (request) =>
      waitTriage(
        {
          store: eventStore,
          runtime: createRuntime,
          mirror: { refSha, listAt, readAt, diffStatAt },
          issue: async (ticketId) => {
            const parsed = parseTicketStream(ticketId)
            if (parsed === null) throw new Error(`invalid ticket stream: ${ticketId}`)
            const state = await loadProject(parsed.project)
            if (state === null) throw new Error(`${parsed.project} is not registered`)
            const { client } = await projectClient(state)
            const live = await client.getIssue(Number(parsed.issue))
            return { ref: String(live.number), title: live.title, body: live.body }
          },
          base: async (ticketId) => {
            const project = parseTicketStream(ticketId)?.project ?? ''
            return (await loadProject(project))?.base ?? 'main'
          },
          prepare,
          now: Date.now,
          log,
        },
        request,
      ),
  }
}

/** Discussion's own bound (`packages/conductor/src/discuss.ts:116`) — a caller is putting this in a prompt. */
const FILE_BYTES = 24_000

/** `triage-<waitId>`, with anything outside `[A-Za-z0-9_-]` replaced so a `/` in a `waitId` cannot leave `chats/`. */
function containmentId(waitId: WaitId): string {
  return `triage-${waitId.replace(/[^A-Za-z0-9_-]/g, '_')}`
}

/** A `why` clipped to `TriageFailed.why`'s own bound — never the append that was meant to record the failure. */
function clip(text: string): string {
  return text.length > TRIAGE_TEXT_MAX ? text.slice(0, TRIAGE_TEXT_MAX) : text
}

export interface TriagePorts {
  store: EventStore
  /** `createRuntime` in production. `tools: 'none'` is the containment, not a preference — see `discuss.ts`'s own `runtime`. */
  runtime(agent: DiscussAgent, options: { tools: 'none' }): Runtime
  mirror: {
    refSha(input: { project: string; ref: string }): Promise<string | null>
    listAt(input: { project: string; ref: string }): Promise<{ paths: string[]; truncated: boolean }>
    readAt(input: { project: string; ref: string; path: string; limitBytes?: number }): Promise<string | null>
    diffStatAt(input: { project: string; base: string; head: string }): Promise<string | null>
  }
  /** The ticket, as GitHub has it now. Throws, or rejects, to say why it could not be read. */
  issue(ticketId: string): Promise<{ ref: string; title: string; body: string }>
  /** The project's base branch. */
  base(ticketId: string): Promise<string>
  /** `apps/cli/src/discuss.ts`'s `prepare` in production — an empty directory and a settings file that denies every tool. */
  prepare(id: string): Promise<{ cwd: string; settingsPath: string }>
  now(): number
  log?(line: string): void
}

export interface WaitTriageRequest {
  ticketId: string
  waitId: WaitId
  reason: WaitReason
  triage: Triage
  signal?: AbortSignal
}

/**
 * The evidence `triageBrief` is handed, gathered through the ports alone —
 * never `@lingtai/conductor/discuss`'s `gatherEvidence`, which reads the
 * global event store and returns the wrong shape (the design note's own
 * reason). A mirror or GitHub failure becomes `null`/`ticketProblem` here,
 * never an exception.
 */
async function gatherEvidence(
  deps: TriagePorts,
  request: WaitTriageRequest,
  before: readonly Envelope[],
): Promise<{ evidence: TriageEvidence; baseSha: string | null; headSha: string | null }> {
  const project = parseTicketStream(request.ticketId)?.project ?? ''

  let ticket: TriageEvidence['ticket'] = null
  let ticketProblem: string | null = null
  try {
    ticket = await deps.issue(request.ticketId)
  } catch (err) {
    ticketProblem = (err as Error).message
  }

  const base = await deps.base(request.ticketId).catch(() => 'main')

  // `'run' in reason` is `wait.ts`'s own test (`allowedResolutions`) —
  // `OwnQuestion` is the one `WaitReason` with no run, and this is not the
  // place to refuse it: whether to triage is `triageStatus`'s call (#444).
  const runId = 'run' in request.reason ? request.reason.run.runId : null

  // 1-based, in the ticket's own claim order (`item.runs`) — the same
  // numbering the detail page and Discussion's `attempt-<n>` ref use. Falls
  // back to 1 rather than null when the run is not found there, so a mirror
  // read never gets suppressed over a numbering gap.
  const runIndex = runId === null ? -1 : reduceTicket(before).runs.indexOf(runId)
  const runAttempt = runId === null ? null : runIndex >= 0 ? runIndex + 1 : 1

  let routed: PayloadOf<'PassRouted'> | null = null
  let published: PayloadOf<'RunRefsPublished'> | null = null
  let head: string | null = null
  if (runId !== null) {
    const runEvents = await deps.store.read(runId).catch((): Envelope[] => [])
    for (const e of runEvents) {
      if (e.type === 'PassRouted') routed = e.data as PayloadOf<'PassRouted'>
      if (e.type === 'RunRefsPublished') published = e.data as PayloadOf<'RunRefsPublished'>
    }
    head = headOf(runEvents)
  }

  const baseSha = await deps.mirror.refSha({ project, ref: base }).catch(() => null)
  const refs: ReadableRef[] = []
  if (baseSha !== null) {
    const listed = await deps.mirror.listAt({ project, ref: base }).catch(() => ({ paths: [], truncated: false }))
    refs.push({ ref: base, sha: baseSha, paths: listed.paths, truncated: listed.truncated })
  }
  let headSha: string | null = null
  if (head !== null) {
    headSha = await deps.mirror.refSha({ project, ref: head }).catch(() => null)
    if (headSha !== null) {
      const listed = await deps.mirror.listAt({ project, ref: headSha }).catch(() => ({ paths: [], truncated: false }))
      refs.push({ ref: `attempt-${runAttempt ?? 1}`, sha: headSha, paths: listed.paths, truncated: listed.truncated })
    }
  }

  const diffStat =
    baseSha !== null && headSha !== null
      ? await deps.mirror.diffStatAt({ project, base: baseSha, head: headSha }).catch(() => null)
      : null

  return {
    evidence: {
      ticketId: request.ticketId,
      ticket,
      ticketProblem,
      reason: request.reason,
      routed,
      published,
      diffStat,
      // `head`, the log's own claim (`headOf`, `RunProducedDiff.headSha`) —
      // never `headSha`, the mirror's resolution of it. A mirror that cannot
      // resolve a head the attempt did produce (a pruned worktree, a re-cloned
      // mirror) must not read as "the attempt committed nothing": the log is
      // what settles whether the attempt produced a commit, the mirror only
      // whether a file can be served for it. `discuss.ts:226`'s own
      // `gatherEvidence` follows the same rule.
      reading: readingFor({ base, baseSha, attempt: runAttempt, head }),
      refs,
    },
    baseSha,
    headSha,
  }
}

/**
 * One wait, triaged. Appends `TriageStarted`, dispatches the agent under
 * Discussion's containment, and ends with exactly one `WaitTriaged` carrying
 * the same `attempt`. Every failure up to and including the agent's own run
 * is caught and turned into a `TriageFailed` `WaitTriaged` rather than
 * thrown — except the `WaitTriaged` append itself, which throws if it still
 * cannot be made to land after retrying, rather than reporting a result that
 * was never recorded.
 */
export async function waitTriage(
  deps: TriagePorts,
  request: WaitTriageRequest,
): Promise<{ attempt: number; result: TriageResult }> {
  const log = deps.log ?? (() => {})
  const stream = request.ticketId

  let before: Envelope[]
  try {
    before = await deps.store.read(stream)
  } catch (err) {
    log(`triage ${request.waitId}: could not read ${stream} — ${(err as Error).message}`)
    return {
      // 0, not 1 — no `TriageStarted` was ever appended, so there is no
      // attempt for this result to share a number with.
      attempt: 0,
      result: { _tag: 'TriageFailed', why: clip(`could not read the ticket: ${(err as Error).message}`) },
    }
  }
  const priorAttempts = before
    .filter((e) => e.type === 'TriageStarted' && (e.data as { waitId?: unknown }).waitId === request.waitId)
    .map((e) => (e.data as { attempt: number }).attempt)
  const attempt = priorAttempts.length === 0 ? 1 : Math.max(...priorAttempts) + 1

  const by = { _tag: 'Agent' as const, runtime: request.triage.agent, model: request.triage.model ?? '' }

  // A `ConcurrencyError` here says only that *something* appended to the
  // ticket stream between the read above and this append — not that it was
  // another triage attempt. `resolveWait` appending `WaitResolved` to the same
  // stream, or any other appender, conflicts the same way a second triage
  // attempt would. So re-read and check: only when the new events actually
  // carry a `TriageStarted` for this same `waitId` is a second attempt really
  // starting; anything else is unrelated, and the append is retried at the
  // fresh version rather than abandoning the triage with a false reason.
  let started = false
  let startedErr: unknown = null
  for (let i = 0; i < 5 && !started; i += 1) {
    try {
      await deps.store.append(stream, before.length, [
        {
          type: 'TriageStarted',
          actor: 'conductor',
          data: parsePayload('TriageStarted', { waitId: request.waitId, attempt, by }),
        },
      ])
      started = true
    } catch (err) {
      if (err instanceof ConcurrencyError) {
        const since = before.length
        before = await deps.store.read(stream)
        const racedByOther = before
          .slice(since)
          .some((e) => e.type === 'TriageStarted' && (e.data as { waitId?: unknown }).waitId === request.waitId)
        if (racedByOther) {
          log(`triage ${request.waitId}: lost the race to start attempt ${attempt} — nothing dispatched`)
          return { attempt, result: { _tag: 'TriageFailed', why: clip('another attempt was already starting') } }
        }
        startedErr = err
        continue
      }
      log(`triage ${request.waitId}: TriageStarted append failed — ${(err as Error).message}`)
      return { attempt, result: { _tag: 'TriageFailed', why: clip(`could not start: ${(err as Error).message}`) } }
    }
  }
  if (!started) {
    const message = startedErr instanceof Error ? startedErr.message : String(startedErr)
    log(`triage ${request.waitId}: TriageStarted append failed — ${message}`)
    return { attempt, result: { _tag: 'TriageFailed', why: clip(`could not start: ${message}`) } }
  }

  let baseSha: string | null = null
  let headSha: string | null = null
  let final: TriageResult

  try {
    const gathered = await gatherEvidence(deps, request, before)
    const evidence = gathered.evidence
    baseSha = gathered.baseSha
    headSha = gathered.headSha

    const chatId = containmentId(request.waitId)
    const { cwd, settingsPath } = await deps.prepare(chatId)
    const runtime = deps.runtime(request.triage.agent, { tools: 'none' })
    const call = triageCallFor(request.triage)
    const usdBudget = call.usd ?? 0.5
    const deadline = deps.now() + call.wallMs

    const project = parseTicketStream(request.ticketId)?.project ?? ''
    const shas = new Map(evidence.refs.map((r) => [r.ref, r.sha]))
    const serve = (ref: string, path: string): Promise<string | null> => {
      const sha = shas.get(ref)
      if (sha === undefined) return Promise.resolve(null)
      return deps.mirror.readAt({ project, ref: sha, path, limitBytes: FILE_BYTES }).catch(() => null)
    }

    // `RunSpent`, retried on any error up to five attempts — the same bound
    // and reasoning `resolve-wait.ts`'s `requestContinuation` uses: a dropped
    // connection is as transient as a lost version race, and the version read
    // above the append is re-taken on every attempt so a concurrent writer
    // (another appender on the same ticket) is not mistaken for one. **A
    // retry is not always "nothing was written" though** — a dropped
    // connection can reject the promise after the transaction already
    // committed, and a blind retry would then append a second, identical
    // `RunSpent` for the one call. So before every attempt (including the
    // first retry), check whether the stream already carries one matching
    // this exact outcome since this `spend()` call started, and treat that as
    // landed rather than writing it again. `null` once it has landed, one way
    // or the other; otherwise the last error's message, which ends the
    // triage rather than leaving a paid call unrecorded.
    const spend = async (outcome: RunOutcome): Promise<string | null> => {
      // `since` is captured from the first read that succeeds, not a read taken
      // before the loop — a transient failure on that very first read (the
      // scenario this retry exists for) must not propagate past this function
      // uncaught, discarding both the ledger row and the advice the call
      // already produced.
      let since: number | null = null
      let lastError: unknown = null
      for (let i = 0; i < 5; i += 1) {
        try {
          const current = await deps.store.read(stream)
          if (since === null) since = current.length
          const alreadyLanded = current.slice(since).some((e) => {
            if (e.type !== 'RunSpent') return false
            const data = e.data as PayloadOf<'RunSpent'>
            return (
              data.for._tag === 'Triage' &&
              data.for.waitId === request.waitId &&
              data.turns === outcome.turns &&
              data.durationMs === outcome.durationMs &&
              data.costUsd === outcome.costUsd
            )
          })
          if (alreadyLanded) return null
          await deps.store.append(stream, current.length, [
            {
              type: 'RunSpent',
              actor: 'conductor',
              data: parsePayload('RunSpent', {
                for: { _tag: 'Triage', waitId: request.waitId },
                runtime: request.triage.agent,
                turns: outcome.turns,
                durationMs: outcome.durationMs,
                usage: outcome.usage ?? [],
                costUsd: outcome.costUsd,
              }),
            },
          ])
          return null
        } catch (err) {
          lastError = err
        }
      }
      const message = lastError instanceof Error ? lastError.message : String(lastError)
      log(`triage ${request.waitId}: RunSpent append failed — ${message}`)
      return message
    }

    const served: { at: string; text: string | null }[] = []
    let costSpent = 0
    let turnsSpent = 0
    let result: TriageResult | null = null

    for (let round = 0; round <= MAX_READ_ROUNDS; round += 1) {
      // An abort during `serve`, between rounds, must not buy another one.
      if (request.signal?.aborted) {
        result = { _tag: 'TriageFailed', why: 'aborted' }
        break
      }

      const wallLeft = deadline - deps.now()
      if (wallLeft <= 0) {
        result = { _tag: 'TriageFailed', why: 'timeout' }
        break
      }

      const usdLeft = usdBudget - costSpent
      if (usdLeft <= 0) {
        result = { _tag: 'TriageFailed', why: 'out of usd' }
        break
      }

      // `call.turns` bounds the whole triage, not one call — `holdDiscussion`
      // hands every round the full budget, but a triage can run
      // `MAX_READ_ROUNDS + 1` rounds, and the recipe's `limits` is documented
      // as what one triage run may spend in total.
      const turnsLeft = call.turns - turnsSpent
      if (turnsLeft <= 0) {
        result = { _tag: 'TriageFailed', why: 'out of turns' }
        break
      }

      const prompt = triageBrief({
        evidence,
        served,
        roundsLeft: MAX_READ_ROUNDS - round,
        ...(request.triage.prompt === undefined ? {} : { prompt: request.triage.prompt }),
      })

      let threw = false
      const outcome = await runtime
        .run({
          runId: `${containmentId(request.waitId)}:${attempt}:${round}`,
          cwd,
          prompt,
          ...(call.model === undefined ? {} : { model: call.model }),
          settingsPath,
          env: runnableEnv({}),
          limits: { turns: turnsLeft, wallMs: wallLeft, usd: usdLeft },
          signal: request.signal,
        })
        .catch((err: unknown): RunOutcome => {
          threw = true
          return {
            exitCode: null,
            turns: 0,
            durationMs: 0,
            costUsd: null,
            failure: { kind: 'crash', detail: (err as Error).message },
            text: null,
            sessionId: '',
          }
        })

      if (!threw) {
        // A call that was billed and cannot be recorded ends the triage —
        // never silently continues to spend more against an under-reporting
        // ledger (`/spend`, 0110 §2).
        const spendProblem = await spend(outcome)
        if (spendProblem !== null) {
          result = { _tag: 'TriageFailed', why: clip(`could not record spend: ${spendProblem}`) }
          break
        }
        if (outcome.costUsd !== null) costSpent += outcome.costUsd
        turnsSpent += outcome.turns
      }

      if (outcome.failure) {
        const kind = outcome.failure.kind
        const why = kind === 'timeout' || kind === 'aborted' ? kind : `${kind}: ${outcome.failure.detail}`
        result = { _tag: 'TriageFailed', why: clip(why) }
        break
      }

      const reply = parseTriage(outcome.text)

      if (reply.kind === 'read' && round < MAX_READ_ROUNDS) {
        for (const at of reply.paths) {
          const cut = at.indexOf(':')
          const ref = at.slice(0, cut)
          const path = at.slice(cut + 1)
          served.push({ at, text: await serve(ref, path) })
        }
        log(`triage ${request.waitId}: served ${reply.paths.length} file(s)`)
        continue
      }

      if (reply.kind === 'advised') {
        result = reply.result
        break
      }

      // `refused`, or a `read` past the last round — both end the triage.
      result = {
        _tag: 'TriageFailed',
        why: clip(
          reply.kind === 'refused' ? reply.why : `the agent asked for files after ${MAX_READ_ROUNDS} rounds of reading`,
        ),
      }
      break
    }

    // Unreachable: the loop above always sets `result` before it exits.
    final = result ?? { _tag: 'TriageFailed', why: 'triage did not run' }
  } catch (err) {
    log(`triage ${request.waitId}: attempt ${attempt} crashed — ${(err as Error).message}`)
    final = { _tag: 'TriageFailed', why: clip(`crashed: ${(err as Error).message}`) }
  }

  // The one append this function's contract is about, so unlike `TriageStarted`
  // above it is neither swallowed nor left to a single attempt. Retried on any
  // error up to five attempts, the version re-read each time, the same bound
  // `spend` and `resolve-wait.ts`'s `requestContinuation` use — a `WaitTriaged`
  // for this `attempt` landing twice is harmless (a reader takes the latest
  // attempt's result, and a retry sends the same one), so unlike `spend` this
  // needs no check for whether an earlier attempt already landed. If it still
  // will not land after five attempts, this throws rather than returning
  // `final` as though it had: `holdDiscussion`'s own terminal append
  // (`discuss.ts:500-508`) is never wrapped in a `try`, for the same reason —
  // a caller told this succeeded when the log carries no `WaitTriaged` would
  // let `triageStatus` read `Interrupted` and buy a second triage of a wait
  // this one already answered. The caller is a daemon subscriber, which logs
  // and drops a thrown error (0015) rather than acting on a false success.
  let lastError: unknown = null
  for (let i = 0; i < 5; i += 1) {
    try {
      const version = (await deps.store.read(stream)).length
      await deps.store.append(stream, version, [
        {
          type: 'WaitTriaged',
          actor: 'conductor',
          data: parsePayload('WaitTriaged', {
            waitId: request.waitId,
            attempt,
            // `headOf(run) ?? baseSha ?? ''` — the empty string is for a mirror
            // with no base either, where `reading` already says no file can be
            // read.
            headSha: headSha ?? baseSha ?? '',
            result: final,
            by,
          }),
        },
      ])
      return { attempt, result: final }
    } catch (err) {
      lastError = err
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError)
  log(`triage ${request.waitId}: WaitTriaged append failed — ${message}`)
  throw lastError
}
