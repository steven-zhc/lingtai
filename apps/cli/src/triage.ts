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
 * test needs none of the real ones. `#413`/`#447` are the production callers
 * that hand this real ports; this file does not wire them.
 */
import type { Runtime, RunOutcome } from '@lingtai/agent'
import { runnableEnv } from '@lingtai/agent-env'
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
  TRIAGE_TEXT_MAX,
  type Envelope,
  type PayloadOf,
  type WaitId,
} from '@lingtai/domain'
import type { TriageResult, WaitReason } from '@lingtai/domain/wait'
import { ConcurrencyError, type EventStore } from '@lingtai/event-store'
import { triageCallFor, type DiscussAgent, type Triage } from '@lingtai/recipe'

import { headOf } from './discuss.ts'

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
      reading: readingForTriage({ base, baseSha, attempt: runAttempt, head: headSha }),
      refs,
    },
    baseSha,
    headSha,
  }
}

/**
 * `readingFor`'s own three lines (`packages/conductor/src/discuss.ts:164-187`),
 * written out rather than imported: importing `@lingtai/conductor/discuss` for
 * one function would pull a runtime-shaped module in beside
 * `@lingtai/conductor/triage`'s pure one, which is exactly the seam
 * `triage.ts`'s header draws. Kept byte-identical to `readingFor`'s wording,
 * including the branch for an attempt that committed nothing, so a reader of
 * both briefs sees the same sentences.
 */
function readingForTriage(input: {
  base: string
  baseSha: string | null
  /** 1-based, in the ticket's own claim order, or null when there is no run to read (`OwnQuestion`). */
  attempt: number | null
  /** The commit the attempt produced, or null when it produced none. */
  head: string | null
}): string[] {
  const lines: string[] = []
  lines.push(
    input.baseSha === null
      ? `${input.base}: not in Lingtai's mirror — no file can be read`
      : `${input.base}: readable at ${input.baseSha.slice(0, 7)}`,
  )
  if (input.attempt === null) return lines
  if (input.head !== null) {
    lines.push(`attempt-${input.attempt}: readable at ${input.head.slice(0, 7)}`)
    return lines
  }
  lines.push(
    `attempt ${input.attempt} left no branch; I am reading ${input.base}. ` +
      'worktree.ts resets the branch with -B on every run, so an attempt that committed nothing ' +
      `left agent/<n> pointing at ${input.base} — there is no code of its own to read.`,
  )
  return lines
}

/**
 * One wait, triaged. Appends `TriageStarted`, dispatches the agent under
 * Discussion's containment, and ends with exactly one `WaitTriaged` carrying
 * the same `attempt` — never throws.
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
      attempt: 1,
      result: { _tag: 'TriageFailed', why: clip(`could not read the ticket: ${(err as Error).message}`) },
    }
  }
  const priorAttempts = before
    .filter((e) => e.type === 'TriageStarted' && (e.data as { waitId?: unknown }).waitId === request.waitId)
    .map((e) => (e.data as { attempt: number }).attempt)
  const attempt = priorAttempts.length === 0 ? 1 : Math.max(...priorAttempts) + 1

  const by = { _tag: 'Agent' as const, runtime: request.triage.agent, model: request.triage.model ?? '' }

  try {
    await deps.store.append(stream, before.length, [
      {
        type: 'TriageStarted',
        actor: 'conductor',
        data: parsePayload('TriageStarted', { waitId: request.waitId, attempt, by }),
      },
    ])
  } catch (err) {
    if (err instanceof ConcurrencyError) {
      log(`triage ${request.waitId}: lost the race to start attempt ${attempt} — nothing dispatched`)
      return { attempt, result: { _tag: 'TriageFailed', why: clip('another attempt was already starting') } }
    }
    log(`triage ${request.waitId}: TriageStarted append failed — ${(err as Error).message}`)
    return { attempt, result: { _tag: 'TriageFailed', why: clip(`could not start: ${(err as Error).message}`) } }
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
    // (another appender on the same ticket) is not mistaken for one. `null`
    // once it lands; otherwise the last error's message, which ends the
    // triage rather than leaving a paid call unrecorded.
    const spend = async (outcome: RunOutcome): Promise<string | null> => {
      let lastError: unknown = null
      for (let i = 0; i < 5; i += 1) {
        try {
          const version = (await deps.store.read(stream)).length
          await deps.store.append(stream, version, [
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
          limits: { turns: call.turns, wallMs: wallLeft, usd: usdLeft },
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
  } catch (err) {
    log(`triage ${request.waitId}: WaitTriaged append failed — ${(err as Error).message}`)
  }

  return { attempt, result: final }
}
