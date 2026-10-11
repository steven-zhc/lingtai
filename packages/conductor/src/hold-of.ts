/**
 * `holdOfPass` — the `Hold` a pass's own blocked ending is, pulled out of
 * `conduct.ts`'s closure so the classification can be unit-tested on literals
 * rather than only through a whole pass.
 *
 * **This is today's classification, not 0118 §1's *who sent it*.** The ADR
 * amended by `8a669849` says a `red`/`verify-failed` route with the rounds
 * spent is `Routed`, because the router sent it to a person — but building
 * that is #452's job. Until then this function keeps answering the question
 * the old `whatIsWaitingOnYou` answered: *what did the pass itself report*,
 * branch by branch, in the same order. `doc/design/the-waiting-lane.md`'s
 * table is the spec this follows; its `Judgement` table is explicit that
 * `Routed` can only ever carry `findings` as the code stands today, so that
 * is the only `when` this function ever writes.
 *
 * A `red` or `verify-failed` refusal with rounds spent stays `CheckRed` /
 * `MergeRefused` here — not `Routed` — and a declined fix round stays
 * `DidNotFinish`, not `Judgement, Declined`. Both are #452's reclassification,
 * not this function's.
 */
import type { CeilingKind, Finding, Hold, RunRef, Step } from '@lingtai/domain'
import {
  diagnoseRefusal,
  integrationStream,
  reduceIntegration,
  RefusalReason as RefusalReasonSchema,
} from '@lingtai/domain'
import type { EventStore } from '@lingtai/event-store'

import type { Destination, PassResult } from './pass.ts'

export type StoppedAt = PassResult['stoppedAt']

export interface LastRoute {
  readonly from: Step
  readonly to: Destination
  readonly why: string
}

export interface IntegrationRefusalEvidence {
  paths: string[] | null
  baseSha: string | null
  headSha: string | null
}

export interface CeilingHit {
  kind: CeilingKind
  detail: string
  turns: number | null
  costUsd: number | null
}

export interface HoldOfPassInput {
  stopped: StoppedAt
  lastRoute: LastRoute | null
  ceilingHit: CeilingHit | null
  findings: readonly Finding[]
  runId: string
  branch: string
  base: string
  unpushed?: { branch: string; said: string }
  repairOf?: { after: string; reason: string }
  /** The row `IntegrationRefused` left on this attempt, or null where none did. */
  integrationRefusal: IntegrationRefusalEvidence | null
}

function said(detail: string, n = 300): string {
  const one = detail.replace(/\s+/g, ' ').trim()
  if (one === '') return 'no detail was recorded'
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

function detailOf(ending: NonNullable<StoppedAt>['ending']): string {
  if ('detail' in ending) return ending.detail
  return 'question' in ending ? ending.question : ending.ending
}

export function holdOfPass(input: HoldOfPassInput): Hold {
  const { stopped } = input
  const run: RunRef = {
    runId: input.runId,
    ...(input.unpushed === undefined ? {} : { unpushed: input.unpushed }),
    ...(input.repairOf === undefined ? {} : { repairOf: input.repairOf }),
  }

  if (stopped?.step === 'merge' && stopped.ending.ending === 'refused') {
    const why = detailOf(stopped.ending)
    const parsedReason = RefusalReasonSchema.safeParse(stopped.ending.because)
    if (parsedReason.success) {
      const reading = diagnoseRefusal({
        reason: parsedReason.data,
        detail: why,
        branch: input.branch,
        base: input.base,
      })
      return {
        _tag: 'MergeRefused',
        run,
        reason: parsedReason.data,
        why: reading.what,
        raw: why,
        paths: input.integrationRefusal?.paths ?? null,
        baseSha: input.integrationRefusal?.baseSha ?? null,
        headSha: input.integrationRefusal?.headSha ?? null,
      }
    }
    return { _tag: 'CheckRed', run, step: 'merge', why: said(why, 400), raw: why }
  }

  if (input.ceilingHit !== null) {
    return {
      _tag: 'Ceiling',
      run,
      kind: input.ceilingHit.kind,
      detail: said(input.ceilingHit.detail),
      turns: input.ceilingHit.turns,
      costUsd: input.ceilingHit.costUsd,
    }
  }

  if (stopped === null) {
    const why = input.lastRoute?.why ?? 'the pass was held for a person'
    return {
      _tag: 'Routed',
      run,
      when: 'findings',
      why: `${input.branch} into ${input.base} is waiting on you. ${said(why, 400)}`,
      raw: input.lastRoute?.why ?? why,
      findings: [...input.findings],
      paths: null,
      baseSha: null,
      headSha: null,
    }
  }

  const { step } = stopped
  switch (stopped.ending.ending) {
    case 'asked':
      return { _tag: 'Asked', run, step, question: detailOf(stopped.ending) }

    case 'held':
      return {
        _tag: 'Human',
        run,
        step,
        source: step === 'merge' ? 'injected' : 'declared',
        question: detailOf(stopped.ending),
        // Only `merge`'s recommendation reads this (`legacyColumns`'s findings
        // veto), but it costs nothing to carry on every `Human` — `findings`
        // is already on `input` for every arrival here.
        findings: [...input.findings],
      }

    case 'refused': {
      const why = detailOf(stopped.ending)
      if (step === 'prepared') {
        return { _tag: 'SetupRefused', run, step, lifts: 'person', why: said(why, 400), raw: why }
      }
      return { _tag: 'CheckRed', run, step, why: said(why, 400), raw: why }
    }

    case 'did-not-finish': {
      const why = detailOf(stopped.ending)
      return { _tag: 'DidNotFinish', run, step, why: said(why, 400), raw: why }
    }

    // Neither reaches the blocked branch: `outcomeOf` reads a stop at
    // `never-ran` as `failed` (a different ending entirely), and `passed`
    // never stops a pass in the first place.
    case 'passed':
    case 'never-ran':
      throw new Error(`holdOfPass: a pass that ${stopped.ending.ending} cannot reach the blocked ending`)
  }
}

/**
 * The `paths`/`baseSha`/`headSha` `IntegrationRefused` recorded for this
 * attempt, or null where nothing refused on this base for this branch.
 *
 * `IntegrateResult` carries only `reason` and `detail` (`repo/src/integrate.ts`)
 * — the three fields `MergeRefused` wants beside them are only on the log, on
 * the integration stream the lane itself appended to. One function, so
 * `conduct.ts`'s own blocked ending and `approve.ts`'s read the same refusal
 * the same way (#445's design, §3).
 */
export async function lastIntegrationRefusal(
  store: Pick<EventStore, 'read'>,
  project: string,
  base: string,
  workItemId: string,
  branch: string,
): Promise<IntegrationRefusalEvidence | null> {
  const events = await store.read(integrationStream(project, base))
  const state = reduceIntegration(events)
  const refusal = state.refusals.findLast((r) => r.workItemId === workItemId && r.branch === branch)
  if (refusal === undefined) return null
  return {
    paths: refusal.paths ?? null,
    baseSha: refusal.baseSha ?? null,
    headSha: refusal.headSha ?? null,
  }
}
