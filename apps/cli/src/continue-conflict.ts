import { userInfo } from 'node:os'

import { loadProject, resolveWait } from '@lingtai/conductor'
import { conflictWorkOf } from '@lingtai/conductor/conflict-work'
import { continueConflictPorts } from '@lingtai/conductor/continue-conflict-ports'
import { reduceTicket, ticketStream, triageFactsOf, type Envelope, type ProjectState } from '@lingtai/domain'
import {
  allowedResolutions,
  confirmHunks,
  conflictRowKey,
  triageStatus,
  type ConflictChoice,
  type Resolution,
} from '@lingtai/domain/wait'
import { eventStore } from '@lingtai/event-store'

import { withProjector } from './projector.ts'

export interface ContinueConflictOptions {
  project: string
  issue: number
  /** Both are required to submit: they tie the confirmation to what was printed. */
  ifBase?: string
  ifHead?: string
  /** Take triage's recommendation for every row it made one for. */
  acceptRecommended?: boolean
  /** `"path:line"` to `"mechanical"`, `{ answer }` or `{ behavior }`, the parsed `--choices` file. */
  choices?: unknown
  grantExtraRound?: boolean
}

/** Everything the command reaches outside itself for, so the unit half can hand it fakes. */
export interface ContinueConflictDeps {
  events(stream: string): Promise<readonly Envelope[]>
  load(project: string): Promise<ProjectState | null>
  ports: typeof continueConflictPorts
  resolve: typeof resolveWait
  by: string
}

const live: ContinueConflictDeps = {
  events: (stream) => eventStore.read(stream),
  load: (project) => loadProject(project),
  ports: continueConflictPorts,
  resolve: resolveWait,
  by: `human:${userInfo().username}`,
}

/** The `--choices` file, or the sentence naming what is wrong with it. */
export function parseChoices(raw: unknown): Record<string, ConflictChoice> | string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return '--choices must be a JSON object mapping "path:line" to "mechanical", {"answer": id} or {"behavior": text}'
  const out: Record<string, ConflictChoice> = {}
  for (const [key, value] of Object.entries(raw)) {
    const v = value as { answer?: unknown; behavior?: unknown }
    if (value === 'mechanical') out[key] = { _tag: 'Mechanical' }
    else if (typeof v?.answer === 'string') out[key] = { _tag: 'Answer', answerId: v.answer }
    else if (typeof v?.behavior === 'string') out[key] = { _tag: 'Behavior', text: v.behavior }
    else return `--choices: "${key}" must be "mechanical", {"answer": id} or {"behavior": text}`
  }
  return out
}

/**
 * `lingtai continue-conflict`: with no confirmation flags it prints the
 * conflict exactly as the board draws it and appends nothing; with
 * `--if-base`/`--if-head` and the choices it submits them to `resolveWait`,
 * the one writer, which checks them against the mirror and the remote.
 */
export async function continueConflictCommand(
  options: ContinueConflictOptions,
  log = console.log,
  deps?: ContinueConflictDeps,
): Promise<number> {
  const run = (d: ContinueConflictDeps) => continueConflict(options, log, d)
  return deps === undefined ? withProjector(log, () => run(live)) : run(deps)
}

async function continueConflict(
  options: ContinueConflictOptions,
  log: (line: string) => void,
  deps: ContinueConflictDeps,
): Promise<number> {
  const state = await deps.load(options.project)
  if (!state) {
    log(`no project named "${options.project}"`)
    return 1
  }
  const ticketId = ticketStream(options.project, options.issue)
  const own = await deps.events(ticketId)
  const item = reduceTicket(own)
  const lifecycle = item.lifecycle

  // The way out of a continuation that was confirmed but not scheduled: resend
  // what the wait recorded, verbatim, and write nothing new.
  if (lifecycle.status === 'approved' && lifecycle.grantRef !== undefined) {
    const recorded = own
      .filter((e) => e.type === 'WaitResolved')
      .map((e) => e.data as { waitId: string; resolution: Resolution })
      .findLast((d) => d.waitId === lifecycle.waitId && d.resolution._tag === 'ContinueConflict')
    if (recorded === undefined) {
      log(`${ticketId} was approved, but not as a conflict continuation`)
      return 1
    }
    return submit(options, log, deps, ticketId, state, lifecycle.waitId, recorded.resolution)
  }

  if (
    lifecycle.status !== 'blocked' ||
    lifecycle.reason._tag !== 'ProposedEscalated' ||
    lifecycle.reason.proposal._tag !== 'MergeConflict' ||
    !allowedResolutions(lifecycle.reason).includes('ContinueConflict')
  ) {
    log(`${ticketId} is not waiting on a conflict that can be continued`)
    return 1
  }
  const { waitId, reason } = lifecycle
  // the guard above holds `MergeConflict`, which destructuring `lifecycle` forgets
  const { baseSha, headSha } = (reason as { proposal: { baseSha: string | null; headSha: string | null } }).proposal
  const ports = await deps.ports(state)
  const runEvents = lifecycle.runId === null ? [] : await deps.events(lifecycle.runId)
  const published = runEvents.findLast((e) => e.type === 'RunRefsPublished')?.data as
    | { branch?: string; headSha?: string }
    | undefined
  const status = triageStatus(reason, triageFactsOf(own, waitId), { declared: true, daemonStartedAt: null })
  const work = await conflictWorkOf({
    proposal: { baseSha: baseSha!, headSha: headSha! },
    saved:
      published?.branch && published.headSha
        ? { head: published.headSha, ref: published.branch }
        : { refusal: 'this run published no head to continue' },
    runEvents,
    status,
    ports: ports.ok ? ports : { refusal: ports.detail },
  })

  if ('refusal' in work) {
    log(`cannot continue: ${work.refusal}`)
    log(`start over from base: lingtai requeue ${options.project} --issue ${options.issue}`)
    return 1
  }
  log(`${options.project} #${options.issue}: ${work.baseBranch} @ ${work.baseSha}  <-  ${work.ref} @ ${work.headSha}`)
  if ('tooMany' in work) {
    log(`${work.tooMany} hunks — past one-by-one; nothing can be confirmed hunk by hunk.`)
    log(`start over from the new base: lingtai requeue ${options.project} --issue ${options.issue}`)
    return 1
  }

  const submitting = options.ifBase !== undefined || options.ifHead !== undefined
  if (!submitting) {
    for (const row of work.rows) {
      log(`\n${conflictRowKey(row)}`)
      if (row.text !== '') log(row.text.replace(/^/gm, '    '))
      if (row.question !== null) {
        log(`  ? ${row.question.text}`)
        for (const a of row.question.answers)
          log(`    ${a.id === row.question.recommended ? '*' : '-'} [${a.id}] ${a.text}`)
      } else if (row.suggested?._tag === 'Mechanical') log('  * mechanical (triage)')
      else log('  no advice — your own intent is required: {"behavior": "..."} or "mechanical"')
    }
    log(
      work.roundsExhausted
        ? '\nThe automatic rounds are spent: add --grant-extra-round to grant one extra paid round.'
        : '\nThis uses one of the run’s remaining automatic rounds.',
    )
    log(
      `\nTo confirm: lingtai continue-conflict ${options.project} --issue ${options.issue} ` +
        `--if-base ${work.baseSha} --if-head ${work.headSha} ` +
        `(--accept-recommended | --choices <file.json>)${work.roundsExhausted ? ' --grant-extra-round' : ''}`,
    )
    log('Confirming asks an AI to continue the preserved branch; build and review run again before anything lands.')
    return 0
  }

  if (options.ifBase === undefined || options.ifHead === undefined) {
    log('--if-base and --if-head are both required to confirm')
    return 2
  }
  if (options.ifBase !== work.baseSha || options.ifHead !== work.headSha) {
    log(
      `the conflict moved since you read it (now base ${work.baseSha}, head ${work.headSha}); nothing was confirmed. Read it again.`,
    )
    return 1
  }
  let choices: Record<string, ConflictChoice> = {}
  if (options.choices !== undefined) {
    const parsed = parseChoices(options.choices)
    if (typeof parsed === 'string') {
      log(parsed)
      return 2
    }
    choices = parsed
  }
  if (options.choices === undefined && !options.acceptRecommended) {
    log('confirming needs --accept-recommended or --choices <file.json>')
    return 2
  }
  // A recommendation applies only when asked for; `--choices` alone confirms only what it names.
  const rows = work.rows.map((row) => (options.acceptRecommended ? row : { ...row, suggested: null }))
  const confirmed = confirmHunks(rows, choices)
  if ('unset' in confirmed) {
    log(
      `no choice for: ${confirmed.unset.map(conflictRowKey).join(', ')}` +
        (options.acceptRecommended ? ' (triage gave no advice for them — your own intent is required)' : ''),
    )
    return 1
  }
  return submit(options, log, deps, ticketId, state, waitId, {
    _tag: 'ContinueConflict',
    baseSha: work.baseSha,
    headSha: work.headSha,
    ref: work.ref,
    hunks: confirmed.hunks,
    grantExtraRound: options.grantExtraRound === true,
  })
}

async function submit(
  options: ContinueConflictOptions,
  log: (line: string) => void,
  deps: ContinueConflictDeps,
  ticketId: string,
  state: ProjectState,
  waitId: string,
  resolution: Resolution,
): Promise<number> {
  const ports = await deps.ports(state)
  if (!ports.ok) {
    log(`cannot continue: ${ports.detail}`)
    return 1
  }
  const result = await deps.resolve({
    ticketId,
    issue: options.issue,
    waitId: waitId as never,
    resolution,
    by: deps.by,
    client: ports.client,
    base: ports.base,
    conflicts: ports.conflicts,
  })
  if (!result.ok) {
    log(`not confirmed (${result.reason}): ${result.detail}`)
    return 1
  }
  if (result.unscheduled !== undefined) {
    log(
      `confirmed, but the continuation was not scheduled (${result.unscheduled}); run this command again to ask for it`,
    )
    return 1
  }
  log(
    result.rescheduled
      ? `already confirmed; asked again for the continuation of ${ticketId}`
      : `confirmed; an AI will continue the preserved branch of ${ticketId}, and build and review run again before anything can land`,
  )
  return 0
}
