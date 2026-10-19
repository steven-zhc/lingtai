/**
 * `holdOfPass` — the `WaitReason` a pass's own blocked ending is, pulled out
 * of `conduct.ts`'s closure so the classification can be unit-tested on
 * literals rather than only through a whole pass.
 *
 * **Since `#472`, steps 2 and 4 below are dead too, and for the same reason
 * as the `refused` case already was.** Every one of the seven `nextOf` can
 * propose — the merge lane's own refusal with no direction (step 2) and
 * `review`'s/`merge`'s own unreadable answer (step 4) included — now sets
 * `pass.end` through `routeProposal`'s `ProposedEscalated`, so `holdFor`
 * takes the `holdOf` branch for them before `holdOfPass` is ever called. The
 * old step 1 — a refusal the router sent on with a direction (`red`,
 * `verify-failed`, `conflict`) — went the same way first, with `#462`'s
 * `arriveAtTheRouter`.
 *
 * **The `refused` case in the switch below is dead for the same reason.** A
 * `prepared` refusal and a `proposed`/`merge` check refusal now set
 * `pass.end` too (`SetupRefused`/`CheckRefused`), so `holdFor` takes the
 * `holdOf` branch for them before `holdOfPass` is ever called — see that
 * case's own comment, which proves the unreachability rather than asserting
 * it here.
 *
 * **`case 'held'` is dead too, for the same reason as `refused`.** A `held`
 * ending comes from one place, `endingOf`'s own `result.heldAt`, which is
 * always the deciding action — a `signoff` yield answers
 * `WaitOnPerson{SignoffRequired}`, a `verdict` yield answers
 * `Propose{CheckRefused}`, and a `worktree` yield answers
 * `Propose{SetupRefused}` (`pass-steps.test.ts`'s `holds the item when the
 * cut asks a question`) — so `pass.end` is set every time, and `holdFor`
 * takes the `holdOf` branch before `holdOfPass` is ever called. What is left
 * live is `case 'did-not-finish'` below: `claim`'s own decline (never
 * routed — `claim` is not one of the seven `proposed` appeals to), a fix
 * round's own decline, set directly by `conduct.ts` rather than through
 * `pass.end` (`declined`, read against `what-a-pass-writes-today.test.ts`'s
 * own *`implement` changes nothing in a fix round*), and a body — or
 * `nextOf` itself — that threw.
 *
 * **On the log directly since #502**: every branch below builds a
 * `WaitReason` (`@lingtai/domain/wait`) rather than the retired `Hold` —
 * `WaitStarted.reason` is the value itself now, with no translation layer
 * behind it.
 */
import { RefusalReason as RefusalReasonSchema, stepOutcomesOf } from '@lingtai/domain'
import type { RunRef, WaitReason } from '@lingtai/domain/wait'
import type { EventStore } from '@lingtai/event-store'

import type { Destination, PassOver } from './pass.ts'

export type StoppedAt = PassOver['stopped']

export interface LastRoute {
  readonly from: string
  readonly to: Destination
  readonly why: string
}

export interface IntegrationRefusalEvidence {
  paths: string[] | null
  baseSha: string | null
  headSha: string | null
}

export interface CeilingHit {
  kind: 'out-of-turns' | 'out-of-usd'
  detail: string
  turns: number | null
  costUsd: number | null
}

export interface HoldOfPassInput {
  stopped: StoppedAt
  lastRoute: LastRoute | null
  ceilingHit: CeilingHit | null
  /**
   * Set when a fix round committed nothing and did not fail — a fixer that
   * read the findings and judged, not one that crashed. `said` is
   * `FixApplied.said`, clipped the same way there. `null` where nothing was
   * declined this pass.
   */
  declined: { said: string | null } | null
  runId: string
  unpushed?: { branch: string; said: string }
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

const AGENT_CRASH_CAUSES = ['crash', 'timeout', 'aborted'] as const

/** `because`'s own word, where it is one of the three; `crash` otherwise — the same fallback `read-model.ts`'s `asInterrupt` carries for a kind that did not reach the wire. */
function crashCauseOf(because: string): 'crash' | 'timeout' | 'aborted' {
  return (AGENT_CRASH_CAUSES as readonly string[]).includes(because)
    ? (because as 'crash' | 'timeout' | 'aborted')
    : 'crash'
}

export function holdOfPass(input: HoldOfPassInput): WaitReason {
  const { stopped } = input
  const run: RunRef = {
    runId: input.runId,
    ...(input.unpushed === undefined ? {} : { unpushed: input.unpushed }),
  }

  // 2. **Dead since `#472`, not a second live arrival.** The merge lane's own
  // refusal with no direction used to stop the lane with `pass.end ===
  // null`, before the diff was what was in doubt; `merge-refused` is already
  // `JudgeWhen`'s own name for these seven — dirty-base, unpushed-base,
  // pending-migration, no-commits, wip-commit, push-rejected, unexpected
  // (`#471`) — and `#472` wires `nextOf` to turn this stop into a
  // `Propose{MergeRefused}`, so it sets `pass.end` through
  // `routeProposal`'s `ProposedEscalated` and `holdFor` takes the `holdOf`
  // branch before `holdOfPass` is ever called.
  if (stopped?.step === 'merge' && stopped.ending.ending === 'refused') {
    const why = detailOf(stopped.ending)
    const parsedReason = RefusalReasonSchema.safeParse(stopped.ending.because)
    if (parsedReason.success) {
      if (parsedReason.data === 'conflict') {
        return {
          _tag: 'ProposedEscalated',
          run,
          proposal: {
            _tag: 'MergeConflict',
            output: why,
            paths: input.integrationRefusal?.paths ?? null,
            baseSha: input.integrationRefusal?.baseSha ?? null,
            headSha: input.integrationRefusal?.headSha ?? null,
          },
          because: { _tag: 'NotAsked' },
        }
      }
      if (parsedReason.data === 'verify-failed') {
        return {
          _tag: 'ProposedEscalated',
          run,
          proposal: { _tag: 'VerifyRed', output: why },
          because: { _tag: 'NotAsked' },
        }
      }
      return {
        _tag: 'MergeRefused',
        run,
        reason: parsedReason.data,
        raw: why,
        ...(input.integrationRefusal?.paths == null ? {} : { paths: input.integrationRefusal.paths }),
        ...(input.integrationRefusal?.baseSha == null ? {} : { baseSha: input.integrationRefusal.baseSha }),
        ...(input.integrationRefusal?.headSha == null ? {} : { headSha: input.integrationRefusal.headSha }),
      }
    }
    return {
      _tag: 'CheckRefused',
      run,
      step: 'merge',
      action: stopped.ending.at ?? '',
      evidence: why,
      findings: [],
    }
  }

  // 3. Nobody decided; the account did.
  if (input.ceilingHit !== null) {
    return { _tag: 'BudgetExhausted', run, cause: input.ceilingHit.kind, detail: said(input.ceilingHit.detail) }
  }

  // 4. **Dead since `#472`, not a second live arrival.** `routeProposal`'s
  // only `WaitOnPerson` branch (`pass.ts`) sets `pass.end = next`, so a
  // `stopped === null` arrival that reaches this far always has a
  // `WaitOnPerson` end too — `holdFor` takes the `holdOf` branch for it
  // before `holdOfPass` is ever called. This
  // used to be the one way the router sent the pass to a person on its own
  // way through, nothing refused, judging `review`'s findings or an
  // unreadable answer at `review`/`merge` — both are `ProposedEscalated` now.
  if (stopped === null) {
    const why = input.lastRoute?.why ?? 'the pass was held for a person'
    return {
      _tag: 'ProposedEscalated',
      run,
      proposal: { _tag: 'ReviewEmpty', said: why, findings: [] },
      because: { _tag: 'JudgeHandedOver', why },
    }
  }

  const { step } = stopped
  switch (stopped.ending.ending) {
    // Goes through the router too (`whenOf`'s `needs-input`,
    // `proposed-route.ts`), but `Asked` carries the agent's question in a
    // field `Routed` has none for, so this is never `ProposedEscalated` with
    // `when: 'needs-input'`.
    case 'asked':
      return { _tag: 'AgentQuestion', run, step: step as 'design' | 'implement', question: detailOf(stopped.ending) }

    case 'held':
      return {
        _tag: 'SignoffRequired',
        run,
        step: step as 'proposed' | 'merge',
        action: stopped.ending.at,
        question: detailOf(stopped.ending),
      }

    // **Dead since `#462`, and kept only so this switch stays exhaustive over
    // `StepEnding['ending']` — not because an older log can still produce
    // one.** `holdOfPass` is handed a live `PassOver.stopped`, built in
    // the same call that invokes it (`conduct.ts`'s `holdFor`), and never a
    // value read back off the log — there is no "log old enough" for this
    // case to still answer to. What makes it unreachable: `nextOf` now sets
    // `pass.end` for every `refused` ending that can stop a pass —
    // `prepared` as `SetupRefused`, `proposed`/`merge`'s own check as
    // `CheckRefused`, `build` as a `Propose{BuildRed}` that routes — so
    // `holdFor` takes the `holdOf` branch for them, before `holdOfPass` is
    // ever called. The one survivor, `merge` with an `IntegrationRefused`
    // reason, is caught by step 2 above.
    case 'refused': {
      const why = detailOf(stopped.ending)
      if (step === 'prepared') {
        return { _tag: 'SetupRefused', run, step, action: stopped.ending.at ?? '', why: said(why, 400) }
      }
      return {
        _tag: 'CheckRefused',
        run,
        step: step as 'proposed' | 'merge',
        action: stopped.ending.at ?? '',
        evidence: said(why, 400),
        findings: [],
      }
    }

    case 'did-not-finish': {
      if (input.declined !== null) {
        return { _tag: 'FixerDisagrees', run, said: input.declined.said }
      }
      const why = detailOf(stopped.ending)
      return {
        _tag: 'AgentCrashed',
        run,
        step: step as 'admit' | 'prepared' | 'design' | 'implement' | 'build' | 'review' | 'proposed' | 'merge',
        cause: crashCauseOf(stopped.ending.because),
        detail: said(why, 400),
      }
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
 * **Reads the merge action's own stored result, not the event** (#502):
 * `IntegrationRefused` on the integration stream carries only `reason`/
 * `detail` now, so the three path fields are read off the run's own
 * `StepEnded` — the merge action's `Completed{integration: Conflicted}` —
 * through `stepOutcomesOf`, the same slice `decidingAction` reads inside a
 * live pass.
 */
export async function lastIntegrationRefusal(
  store: Pick<EventStore, 'read'>,
  runId: string,
): Promise<IntegrationRefusalEvidence | null> {
  const outcomes = stepOutcomesOf(await store.read(runId))
  const merged = outcomes
    .filter((o) => o.step === 'merge')
    .flatMap((o) => o.actions)
    .filter((a) => a.yields === 'merge')
    .map((a) => (a as Extract<typeof a, { yields: 'merge' }>).result)
    .reverse()
    .find((r) => r._tag === 'Completed' && r.integration._tag === 'Conflicted')
  if (merged === undefined || merged._tag !== 'Completed' || merged.integration._tag !== 'Conflicted') return null
  return {
    paths: merged.integration.paths,
    baseSha: merged.integration.baseSha,
    headSha: merged.integration.headSha,
  }
}
