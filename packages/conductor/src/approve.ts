import {
  legacyColumns,
  mergeRefusalProposal,
  parsePayload,
  reduceRun,
  reduceWorkItem,
  waitsOf,
  type RunState,
} from '@lingtai/domain'
import { workItemStream } from '@lingtai/domain'
import { allowedResolutions, type WaitReason } from '@lingtai/domain/wait'
import { createFileLocker } from '@lingtai/env/lock'
import { ConcurrencyError, type EventStore, eventStore } from '@lingtai/event-store'
import type { GitHubClient } from '@lingtai/github'
/**
 * Granting the approval a held run is waiting for, and merging what was
 * actually looked at.
 *
 * `--no-merge` on its own is half a feature. The obvious way to finish a held
 * run — run it again without the flag — starts a *new* run: a new worktree, the
 * agent again, and a different diff. The thing that merges is then not the thing
 * anyone approved, which defeats the entire point of stopping to look.
 *
 * So this takes the held run's own `headSha` and merges that. `onSha` does the
 * work it was designed for: the approval was recorded against a commit, and if
 * the branch has moved since, this refuses rather than merging something nobody
 * agreed to.
 *
 * This is a stopgap with a known shape. It is the CLI half of #21 — approve on
 * the board — and when that lands the two must become one path rather than two
 * vocabularies for one idea. What is here is what makes `--no-merge`
 * mean something before then.
 */
import { type StepAction, type ResolvedRecipe, resolveLocalRecipe } from '@lingtai/recipe'
import { integrate, type TokenSource } from '@lingtai/repo'

import { agentBranch } from './branches.ts'
import { resolveEndActions } from './end-step.ts'
import { labelsFor } from './labels.ts'
import { signedInHere } from './projects.ts'
import { tellGitHubAbout, type RefChannel } from './tell.ts'
import type { Tickets } from './ticket-store.ts'

/**
 * One decision about a work item at a time: `approve` and `requeue` hold this
 * for as long as they act (#150).
 *
 * **The log cannot serialise them on its own.** An approval appends to the run
 * and then merges, for seconds, before it appends to the item; a requeue
 * appends to the item. Requeue sits beside Approve now, so a requeue landing
 * after the approval's append and before its merge put the item back in the
 * queue while the diff it sent back went on to land — onto an item a new run
 * had already claimed. No version check spans two streams and a push.
 *
 * The file lock the daemon and the board take (`@lingtai/env/lock`, #193):
 * whoever arrives second is refused and told why, rather than waiting, and a
 * process that dies holding it has it released by the kernel — so a merge
 * interrupted by a crash does not leave the card with a requeue that refuses
 * for ever, which is the dead end #84 is about. The board and the CLI deciding
 * about one item are on one machine, which is all a file lock covers.
 */
async function deciding<T>(ticketId: string, busy: () => T, act: () => Promise<T>): Promise<T> {
  const got = await createFileLocker().tryLock(`decide:${ticketId}`, 'lingtai-decide')
  if (!got.ok) return busy()
  try {
    return await act()
  } finally {
    await got.lock.release()
  }
}

/**
 * The gates still refusing the sha an approval is about, by `point:action`.
 *
 * **Read off the run, never named by a caller** (#150). The Waive button took a
 * gate from the card, and the home board's card sent the literal `"build"` —
 * so a waived `review` went on the log as a waived `build`. Nothing a person
 * clicks names a gate any more; the run says which ones refused.
 *
 * `failed`, `never-ran`, `did-not-finish` and `asked` alike: a gate whose agent
 * never started, started and produced no receipt, or stopped to ask something,
 * did not pass either, and merging over one is merging past a point nobody
 * judged. A verdict on any other sha is not about this diff and is left out, as
 * `stepsOn` does.
 *
 * `asked` is the newest of the four and belongs here for the reason the other
 * three do rather than for a new one (`#296`): *there is a question about this
 * diff and nobody answered it* is not a judgement of it.
 */
const UNPASSED = new Set(['failed', 'never-ran', 'did-not-finish', 'asked'])

export function refusingOn(run: RunState, onSha: string): string[] {
  return Object.values(run.steps)
    .filter((g) => g.onSha === onSha && UNPASSED.has(g.verdict))
    .map((g) => g.step)
}

export interface ApproveOptions {
  project: string
  issue: number
  base: string
  /**
   * `refSha` for the staleness check against the branch (#150); `Tickets`,
   * `RefChannel` and `owner`/`repo` for everything else this does to the
   * ticket and the merge (#383) — the ticket verbs on `tellGitHubAbout`'s
   * call, `owner`/`repo` on `integrate`'s. The same shape `conduct.ts` calls
   * `PassClient`, named out here instead of imported from there so this file
   * does not reach `conduct.ts` for one type. `TicketedClient`
   * (`ticket-store.ts`) satisfies it, and so does `OwnerlessClient`'s
   * (`ownerless.ts`).
   *
   * **`owner` is null for a project with no GitHub owner** (`#352`), same as
   * `PassClient`'s — `integrate` declares the field and never reads it
   * (`IntegrateOptions`, `integrate.ts`), so the call below passes
   * `owner ?? ''` rather than `IntegrateOptions` growing a branch of its own.
   */
  client: Tickets & RefChannel & Pick<GitHubClient, 'refSha' | 'repo'> & { readonly owner: string | null }
  /** The recipe whose `end` point runs. The machine's file unless a test says otherwise. */
  recipe?: () => Promise<ResolvedRecipe>
  /** Recorded on the approval. A waiver is never anonymous, and neither is this. */
  by: string
  /**
   * The sha the caller was looking at when they decided.
   *
   * Distinct from the approval's own `onSha`, and both are checked. A board
   * card renders a commit; if the branch moved *and a new approval was
   * requested* since, the run's current question is about a different diff than
   * the one on screen, and answering it would be answering a question nobody
   * read. The CLI omits this because it has just printed the state it is acting
   * on; the board always sends it.
   */
  onSha?: string
  /**
   * Why. Optional only while every gate on the sha agrees: an approval over a
   * gate that still refuses is a waiver of it, and is refused without one
   * (#150). See `refusingOn`.
   */
  note?: string
  token?: TokenSource
  home?: string
  gitEnv?: NodeJS.ProcessEnv
  store?: EventStore
  log?: (line: string) => void
}

export type ApproveResult =
  | { ok: true; ticketId: string; runId: string; mergeCommit: string }
  | { ok: false; ticketId: string; reason: string; detail: string }

export async function approve(options: ApproveOptions): Promise<ApproveResult> {
  const ticketId = workItemStream(options.project, options.issue)
  // Held through the merge and the append that ends it, so a requeue cannot
  // put the item back in the queue while this is landing it. See `deciding`.
  return deciding<ApproveResult>(
    ticketId,
    () => ({
      ok: false,
      ticketId,
      reason: 'busy',
      detail: `${ticketId} is being decided by someone else right now. Nothing was merged — reload and read it again.`,
    }),
    () => approveHolding(options, ticketId),
  )
}

/**
 * **Exported for the unit half alone** (`#487`). `approve()` above takes
 * `createFileLocker()` (`deciding`), which is the filesystem, so by 0060 §1
 * the whole of `approve()` cannot be unit-tested — this function underneath
 * it can, and `index.ts` does not re-export it, so nothing outside this
 * module or a test gains a second way to grant an approval unlocked.
 */
export async function approveHolding(options: ApproveOptions, ticketId: string): Promise<ApproveResult> {
  const store = options.store ?? eventStore
  const log = options.log ?? (() => {})

  const item = reduceWorkItem(await store.read(ticketId))
  const runId = item.runs[item.runs.length - 1]
  if (!runId) {
    return { ok: false, ticketId, reason: 'no-run', detail: `${ticketId} has never been run` }
  }

  const run = reduceRun(await store.read(runId))

  // **The item has to be holding this run, too** (#150). Requeue is offered
  // beside Approve now, so a card left open in a second tab — or `lingtai
  // approve` — can arrive after a person sent the ticket back for a new run.
  // The run alone cannot say so; the item can.
  if (item.lifecycle.status !== 'blocked' || (item.lifecycle.runId !== null && item.lifecycle.runId !== runId)) {
    return {
      ok: false,
      ticketId,
      reason: 'not-blocked',
      detail: `${ticketId} is ${item.lifecycle.status}, not held on ${runId} — nothing was merged`,
    }
  }

  /**
   * **The sha an approval is about.** `run.lifecycle.onSha` for a declared
   * `human:`/`--no-merge` signoff — still a `signoff` action, so it still
   * reaches `awaiting-approval` through `StepEnded` (`run.ts`). The "merge it
   * anyway" offer `conduct.ts` makes after an unrelated refusal is not one of
   * those: it never runs a pipeline action, so nothing sets `run.lifecycle`
   * for it now that `ApprovalRequested` is gone (#502) — a reader `#474`–`#476`
   * missed. Falls back to `run.headSha`, gated on the ticket's own wait still
   * allowing `Approve` (0118 §1's `allowedResolutions`), which an `unpushed`
   * run or a wait that never offered it both already refuse.
   */
  let onSha: string
  if (run.lifecycle.status === 'awaiting-approval') {
    onSha = run.lifecycle.onSha
  } else if (run.headSha !== null && allowedResolutions(item.lifecycle.reason).includes('Approve')) {
    onSha = run.headSha
  } else {
    // Including "already merged". Saying which state it is in is more useful
    // than saying it is not the right one.
    return {
      ok: false,
      ticketId,
      reason: 'not-awaiting-approval',
      detail: `${runId} is ${run.lifecycle.status}, not waiting for approval`,
    }
  }
  const branch = agentBranch(options.issue)

  if (options.onSha && options.onSha !== onSha) {
    return {
      ok: false,
      ticketId,
      reason: 'stale',
      detail:
        `the card showed ${options.onSha.slice(0, 7)} and the run is now asking about ` +
        `${onSha.slice(0, 7)}. Nothing was merged — reload and read it again.`,
    }
  }

  // **Approve absorbs the waiver** (#150). Waiving was a second click that
  // recorded a sentence and changed nothing about what this function then did,
  // so the path that explained itself cost twice the one that did not. Now a
  // refusal still standing on this sha is waived here, in the same append as
  // the approval, and there is no way past it without saying why.
  const refusing = refusingOn(run, onSha)
  const note = options.note?.trim() ?? ''
  if (refusing.length > 0 && !note) {
    return {
      ok: false,
      ticketId,
      reason: 'reason-required',
      detail:
        `${refusing.join(', ')} still ${refusing.length === 1 ? 'refuses' : 'refuse'} ${onSha.slice(0, 7)}, ` +
        `so approving waives ${refusing.length === 1 ? 'it' : 'them'} — say why. Nothing was merged.`,
    }
  }

  // The check that makes the approval mean anything. A verdict is about a diff,
  // and between the hold and now someone may have pushed to this branch —
  // including the agent, on a re-run. Merging then would land something no
  // person ever looked at, which is exactly what the old label-based approval
  // did and why `onSha` exists.
  const remoteHead = await options.client.refSha(`heads/${branch}`).catch(() => null)
  if (remoteHead !== onSha) {
    return {
      ok: false,
      ticketId,
      reason: 'stale',
      detail:
        `the approval is for ${onSha.slice(0, 7)} and ${branch} is now ` +
        `${remoteHead?.slice(0, 7) ?? 'gone'}. Nothing was merged.`,
    }
  }

  // The `end` point is a *point*, not a step of `runOnce`: it fires on every
  // terminal outcome, and this is one of the paths that reaches one. Reading
  // the recipe is what the conductor does and a projection may not, so the plan
  // has to be resolved here and written down.
  //
  // From this machine's `~/.lingtai/<project>/recipe.yml`, the read every other
  // command makes (0046 §3) — never from the agent's branch, which is the thing
  // being judged, and now never from the repository at all.
  // Before the approval is recorded, so an unreadable recipe refuses without
  // merging rather than landing a change whose `end` point silently could not
  // run. That silence is the defect this is fixing.
  //
  // The `end` plan is the whole of what this read is for. It used to also lift
  // `runtime.limits.rounds` out, because a failed merge here asked the recipe
  // whether it bought an agent; `#143` takes that question away, so a refusal
  // needs nothing from the recipe but the point it has to resolve.
  let end: readonly StepAction[]
  try {
    const recipe = await (
      options.recipe ?? (() => resolveLocalRecipe(options.project, { base: options.base, signedIn: signedInHere }))
    )()
    end = recipe.recipe.steps.end
  } catch (err) {
    return {
      ok: false,
      ticketId,
      reason: 'recipe',
      detail: `${(err as Error).message}. Nothing was merged.`,
    }
  }

  // At the version read above, so a run that moved since it was read — a
  // second approval, a re-request on a new head — is not approved unread.
  //
  // **A single `WaitResolved{Approve}`, on the ticket stream, replaces the
  // per-gate waivers and `ApprovalGranted`** (#502, 0118 §11): nothing on
  // 0120's catalogue brings the waivers back (that is #465's, continuing the
  // run), so what still refuses this sha is overruled without a second event
  // naming it. The reason a person gave still has to exist — `refusing`,
  // above — it is just carried on `note` alone now.
  try {
    await store.append(ticketId, item.version, [
      {
        type: 'WaitResolved',
        actor: options.by,
        data: parsePayload('WaitResolved', {
          waitId: item.lifecycle.waitId,
          by: options.by,
          resolution: { _tag: 'Approve', onSha },
          note,
        }),
      },
    ])
  } catch (err) {
    if (!(err instanceof ConcurrencyError)) throw err
    return {
      ok: false,
      ticketId,
      reason: 'stale',
      detail: `${ticketId} moved while this was being approved. Nothing was merged — reload and read it again.`,
    }
  }
  if (refusing.length > 0) log(`waived ${refusing.join(', ')} on ${onSha.slice(0, 7)}: ${note}`)
  log(`approved ${onSha.slice(0, 7)} by ${options.by}`)

  const merged = await integrate({
    project: options.project,
    // '' when there is no owner, for the same reason `conduct.ts`'s two call
    // sites do: `integrate` declares the field and never reads it.
    owner: options.client.owner ?? '',
    repo: options.client.repo,
    base: options.base,
    branch,
    ticketId,
    headSha: onSha,
    // The gates already ran and their verdicts are on the log against this same
    // sha. A person approving a red build is granting a waiver, and the log
    // shows both the failure and the approval rather than one hiding the other.
    stepsPassed: true,
    token: options.token,
    home: options.home,
    gitEnv: options.gitEnv,
    store,
  })

  if (!merged.ok) {
    /**
     * **This is the dead end `#84` is about.**
     *
     * The approval has been consumed — `ApprovalGranted` is in the append
     * above — and the run is back to `gating`, which `approve()` refuses. No command
     * anywhere re-requested one, so once an approved merge failed on a conflict
     * that item could never be approved again. Three items sat here, one of
     * them for four days.
     *
     * So the failure gets an outcome rather than a headstone: it is **blocked
     * with a diagnosis**, so the card has a sentence saying what refused, whose
     * failure it is and what move is left, instead of a control that refuses.
     *
     * 0025 answered it by buying an agent here — a whole new run, told what
     * went wrong, which came back asking for approval on the head it produced.
     * `#143` takes the purchase away and keeps the outcome: there is nothing
     * for this branch to send a second worktree to do that `Requeue` does not
     * do for the price of a click, and 0039 §Consequences says a refusal buys
     * nothing. Which means this path is now the *only* one a refused merge
     * takes, from here or from a pass.
     */
    const blocked = await store.read(ticketId)
    // **Choice 1's one exception** (#502, 0118 §1): every other escalation
    // routes through `proposed` first, but no route ran here — the approval
    // already spent the only decision there was to make, and this is just
    // the lane refusing a second time. `mergeRefusalProposal` is the same
    // mapping `pass-next.ts`'s `mergeCompletedRefused` uses, fed from this
    // `integrate()` call's own `IntegrateResult.conflict` rather than from the
    // log — `IntegrationRefused` carries no conflict fields any more.
    const proposal = mergeRefusalProposal(merged.reason, merged.detail, merged.conflict ?? null)
    const reason: WaitReason = {
      _tag: 'ProposedEscalated',
      // No `unpushed`: the run is bound to `onSha`, already on origin.
      run: { runId },
      proposal,
      because: { _tag: 'NotAsked' },
    }
    const question = legacyColumns(reason, { branch, base: options.base, findings: [] }).question
    const ended = resolveEndActions(blocked, end, 'blocked')
    await store.append(ticketId, blocked.length, [
      // `WaitResolved{Approve}` was already appended above: a reader sees the
      // approval spent and this wait starting right after it, with no
      // `afterApproval` flag needed to say so (0118 §11).
      {
        type: 'WaitStarted',
        actor: 'conductor',
        data: parsePayload('WaitStarted', { waitId: crypto.randomUUID(), reason }),
      },
      ...ended,
    ])
    await tellGitHubAbout({
      store,
      github: options.client,
      ticketId,
      question,
      labels: labelsFor('waiting'),
      appended: ended,
    })
    return { ok: false, ticketId, reason: merged.reason, detail: merged.detail }
  }

  const landed = await store.read(ticketId)
  // The same append, so an item cannot land without its `end` point being
  // resolved in the same transaction.
  const ended = resolveEndActions(landed, end, 'landed')
  await store.append(ticketId, landed.length, [
    {
      type: 'TicketLanded',
      actor: 'conductor',
      data: parsePayload('TicketLanded', { mergeCommit: merged.mergeCommit, base: options.base }),
    },
    ...ended,
  ])
  await tellGitHubAbout({
    store,
    github: options.client,
    ticketId,
    labels: labelsFor('landed'),
    appended: ended,
  })
  log(`landed ${merged.mergeCommit.slice(0, 7)} on ${options.base}`)
  return { ok: true, ticketId, runId, mergeCommit: merged.mergeCommit }
}

/**
 * Putting a blocked item back in the queue, from any blocked card (#150).
 *
 * **A card must never offer only a control that refuses.** That is the `#84`
 * complaint stated as a rule: an item whose integration failed is `blocked`
 * with a question, its run is `gating`, and `approve()` will not touch it.
 * Before this, the board rendered Approve on it anyway and the button could not
 * work.
 *
 * **And since `#143` every refused merge ends there**, rather than some of them
 * buying a run instead — so this is the move the commonest failure in the
 * system waits on, and not the leftover it was written as.
 *
 * The move is not a new mechanism. Resolving a wait has been in the
 * catalogue since the beginning and means exactly this: a person answered the
 * question, and the item is queueable again. The next pass cuts a fresh branch
 * from a base that has since moved, which for the commonest case — a conflict
 * nobody chose to repair — is the whole of the fix.
 *
 * No GitHub call. `labelsFor("queued")` is empty, so there is nothing to say
 * that is not already implied, and `reconcile` converges the label an earlier
 * block left behind. A decision here does not need a network round trip to
 * count.
 */
export async function requeue(options: {
  project: string
  issue: number
  by: string
  /**
   * Why, on the record — optional (#424). A requeue of a run's block folds into
   * an `AnswerRecord` only when `runId` is set (`work-item.ts`), and
   * `answersBrief` keeps only the ones with `runId === null`
   * (`attempts.ts:572`); a requeue of a question is written `withdrawn`, which
   * the fold keeps no answer for. So an optional note here never reaches a
   * later attempt's prompt, unlike `answer()`'s.
   */
  note: string
  /**
   * What to do with a question asked before any run: withdraw it (the default,
   * `lingtai requeue` and the board's Withdraw), or refuse. The board's Send
   * refuses — it checks first, but a `lingtai ask` landing between that check
   * and this read would otherwise be withdrawn under a note about a document.
   */
  onQuestion?: 'withdraw' | 'refuse'
  store?: EventStore
}): Promise<{ ok: boolean; ticketId: string; detail: string }> {
  const store = options.store ?? eventStore
  const ticketId = workItemStream(options.project, options.issue)

  // **Never while an approval is acting on the item** (#150). Requeue sits
  // beside Approve now, and an approval that has appended and is still merging
  // leaves the item `blocked` for seconds; unblocking it then let the diff land
  // on an item a new run had claimed. The run is left as it is: an approval
  // that arrives after this reads the item, which is no longer holding it. See
  // `deciding`.
  return deciding(
    ticketId,
    () => ({
      ok: false,
      ticketId,
      detail: `${ticketId} is being decided by someone else right now — an approval may be merging it. Reload and read it again`,
    }),
    () => requeueHolding(options, store, ticketId),
  )
}

/** Exported for the unit half alone — see `approveHolding`'s own comment. */
export async function requeueHolding(
  options: { by: string; note: string; onQuestion?: 'withdraw' | 'refuse' },
  store: EventStore,
  ticketId: string,
): Promise<{ ok: boolean; ticketId: string; detail: string }> {
  const events = await store.read(ticketId)
  const item = reduceWorkItem(events)
  if (item.lifecycle.status !== 'blocked') {
    // Saying which state it is in, for the reason `approve` does: "not blocked"
    // sends somebody nowhere, and "it is already running" answers the question.
    return {
      ok: false,
      ticketId,
      detail: `${ticketId} is ${item.lifecycle.status}, not blocked`,
    }
  }
  // **A block no run holds is a question about the ticket (#147), and a requeue
  // withdraws it rather than answering it.** The fold keeps whatever note ends
  // such a block as a decision and carries it into every later prompt
  // (`answersBrief`), so a requeue's why — *asked by mistake, ignore* — is
  // written `withdrawn`, which the fold keeps nothing of. Answering is
  // `answer()`'s. Refusing here instead left a mistaken question no way out
  // but an answer every attempt would be told.
  //
  // **An `OwnQuestion` is the only wait a requeue withdraws** — every other
  // wait carries a run, which is exactly `item.lifecycle.runId === null` read
  // the old way.
  const wait = waitsOf(events).at(-1)!
  const withdrawn = wait.reason._tag === 'OwnQuestion'
  if (withdrawn && options.onQuestion === 'refuse') {
    return {
      ok: false,
      ticketId,
      detail: `${ticketId} is asking a question before any run — answer it first`,
    }
  }

  // Trimmed, so a whitespace-only box lands as the empty string rather than
  // verbatim (#424) — a blank note is stored as empty, never invented.
  const note = options.note.trim() ? options.note : ''

  await store.append(ticketId, item.version, [
    {
      type: 'WaitResolved',
      actor: options.by,
      data: parsePayload('WaitResolved', {
        waitId: wait.waitId,
        by: options.by,
        resolution: { _tag: 'Requeue' },
        note,
      }),
    },
  ])

  return {
    ok: true,
    ticketId,
    detail: withdrawn
      ? `question withdrawn, by ${options.by} — back in the queue, and no attempt is told it`
      : `back in the queue, by ${options.by}`,
  }
}

// **`waive()` is gone (#502).** It appended `StepWaived`, which 0120's
// appendix retires with no replacement — the standalone waiver `waive()`
// built is "has no caller" there, and nothing in this codebase called it
// either (`index.ts` re-exported it and nothing imported that). `approve()`
// still absorbs a waiver as part of granting an approval (`refusingOn`,
// above); what is gone is waiving a step on its own, with no approval beside
// it.
