/**
 * `holdOfPass` — the `Hold` a pass's own blocked ending is, pulled out of
 * `conduct.ts`'s closure so the classification can be unit-tested on literals
 * rather than only through a whole pass.
 *
 * **Since `#462`, the only arrival this still classifies live is the merge
 * lane's own refusal with no direction** (0120 *Two phases*: `proposed`'s
 * real routing now reaches a person through `pass.waitOn`/`holdOf`, never
 * through here) — step 2 below. The old step 1 — a refusal the router sent on
 * with a direction (`red`, `verify-failed`, `conflict`) — is gone with
 * `arriveAtTheRouter`: every one of those is a `Propose` now, and reaches a
 * person as `WaitOnPerson{ProposedEscalated}` through `pass.waitOn`, never
 * through `stoppedAt`/`rested` alone.
 *
 * **The `refused` case in the switch below is dead for the same reason, not
 * a second live arrival.** A `prepared` refusal and a `proposed`/`merge`
 * check refusal now set `pass.waitOn` too (`SetupRefused`/`CheckRefused`), so
 * `holdFor` takes the `holdOf` branch for them before `holdOfPass` is ever
 * called — see that case's own comment, which proves the unreachability
 * rather than asserting it here.
 *
 * Step 4 (`stopped === null`) survives for the one case that still rests
 * with neither: `review`'s own unreadable answer, which walks on to
 * `proposed`'s spine visit and leaves a fixed `PassRouted` row without ever
 * asking `offerFor` a question.
 */
import type { CeilingKind, Finding, Hold, RunRef, Step } from '@lingtai/domain'
import {
  diagnoseRefusal,
  integrationStream,
  reduceIntegration,
  RefusalReason as RefusalReasonSchema,
} from '@lingtai/domain'
import type { EventStore } from '@lingtai/event-store'

import type { Destination, PassResult, Rest } from './pass.ts'

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
  /**
   * Where the pass came to rest (`PassResult.rested`) — `'waiting'` is the
   * one value that says the router sent this arrival to a person, which
   * `stopped` alone cannot: a refusal the router judged and sent on reports
   * the step that did not pass, not the router that sent it.
   */
  rested: Rest | null
  /**
   * Set when a fix round committed nothing and did not fail — a fixer that
   * read the findings and judged, not one that crashed. `said` is
   * `FixApplied.said`, clipped the same way there. `null` where nothing was
   * declined this pass.
   */
  declined: { said: string | null } | null
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

  // 2. The merge lane refused with no direction — it stops the lane before
  // the diff is what is in doubt. `merge-refused` is already `JudgeWhen`'s
  // own name for these seven — dirty-base, unpushed-base, pending-migration,
  // no-commits, wip-commit, push-rejected, unexpected (`#471`) — but until
  // `#472` wires `nextOf` to turn this stop into a `MergeRefused` proposal,
  // nothing routes it through `proposed`'s judge and a person is next here.
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
        // The pass's own refusal: nobody has approved this sha yet.
        afterApproval: false,
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

  // 3. Nobody decided; the account did.
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

  // 4. The router sent the pass to a person on its own way through — nothing
  // refused, and what it judged was `review`'s findings.
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
    // Goes through the router too (`whenOf`'s `needs-input`,
    // `proposed-route.ts`), but `Asked` carries the agent's question in a
    // field `Routed` has none for, so this is never `Routed{when:
    // 'needs-input'}`.
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

    // **Dead since `#462`, and kept only so this switch stays exhaustive over
    // `StepEnding['ending']` — not because an older log can still produce
    // one.** `holdOfPass` is handed a live `PassResult.stoppedAt`, built in
    // the same call that invokes it (`conduct.ts`'s `holdFor`), and never a
    // value read back off the log — there is no "log old enough" for this
    // case to still answer to. What makes it unreachable: `nextOf` now sets
    // `pass.waitOn` for every `refused` ending that can stop a pass —
    // `prepared` as `SetupRefused`, `proposed`/`merge`'s own check as
    // `CheckRefused`, `build` as a `Propose{BuildRed}` that routes — so
    // `holdFor` takes the `holdOf` branch for them, before `holdOfPass` is
    // ever called. The one survivor, `merge` with an `IntegrationRefused`
    // reason, is caught by step 2 above.
    case 'refused': {
      const why = detailOf(stopped.ending)
      if (step === 'prepared') {
        return { _tag: 'SetupRefused', run, step, lifts: 'person', why: said(why, 400), raw: why }
      }
      return { _tag: 'CheckRed', run, step, why: said(why, 400), raw: why }
    }

    case 'did-not-finish': {
      if (input.declined !== null) {
        return { _tag: 'Declined', run, step, said: input.declined.said }
      }
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
