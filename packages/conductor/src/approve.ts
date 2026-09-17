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
import { type GateAction, type ResolvedRecipe, resolveLocalRecipe } from "@lingtai/recipe";
import { signedInHere } from "./projects.ts";
import { parsePayload, reduceRun, reduceWorkItem, type RunState } from "@lingtai/domain";
import type { GitHubClient } from "@lingtai/github";
import { ConcurrencyError, type EventStore, eventStore } from "@lingtai/event-store";
import { workItemStream } from "@lingtai/domain";
import { resolveEndActions } from "./end-point.ts";
import { labelsFor } from "./labels.ts";
import { diagnoseRefusal } from "./attribution.ts";
import { tellGitHubAbout } from "./tell.ts";
import { integrate, type TokenSource } from "@lingtai/repo";
import { createFileLocker } from "@lingtai/env/lock";

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
 * The file lock the merge lane and the daemon take (`@lingtai/env/lock`, #193):
 * whoever arrives second is refused and told why, rather than waiting, and a
 * process that dies holding it has it released by the kernel — so a merge
 * interrupted by a crash does not leave the card with a requeue that refuses
 * for ever, which is the dead end #84 is about. The board and the CLI deciding
 * about one item are on one machine, which is all a file lock covers.
 */
async function deciding<T>(workItemId: string, busy: () => T, act: () => Promise<T>): Promise<T> {
  const got = await createFileLocker().tryLock(`decide:${workItemId}`, "lingtai-decide");
  if (!got.ok) return busy();
  try {
    return await act();
  } finally {
    await got.lock.release();
  }
}

/**
 * `proposed:build` → the point and the action.
 *
 * A person decides about the thing the card names, which is the composite key
 * (`point:action`); the event carries the two fields separately, because "the
 * build failed" and "something at the `proposed` point failed" are different
 * questions. Splitting at the first colon, since a point never contains one.
 */
function splitGate(key: string): { gate: string; action: string } {
  const cut = key.indexOf(":");
  if (cut < 0) return { gate: "merge", action: key };
  return { gate: key.slice(0, cut), action: key.slice(cut + 1) };
}

/**
 * The gates still refusing the sha an approval is about, by `point:action`.
 *
 * **Read off the run, never named by a caller** (#150). The Waive button took a
 * gate from the card, and the home board's card sent the literal `"build"` —
 * so a waived `review` went on the log as a waived `build`. Nothing a person
 * clicks names a gate any more; the run says which ones refused.
 *
 * `failed` and `never-ran` both: a gate whose agent never started did not pass
 * either, and merging over it is merging past a point nobody judged. A verdict
 * on any other sha is not about this diff and is left out, as `gatesOn` does.
 */
export function refusingOn(run: RunState, onSha: string): string[] {
  return Object.values(run.gates)
    .filter((g) => g.onSha === onSha && (g.verdict === "failed" || g.verdict === "never-ran"))
    .map((g) => g.gate);
}

export interface ApproveOptions {
  project: string;
  issue: number;
  base: string;
  client: GitHubClient;
  /** The recipe whose `end` point runs. The machine's file unless a test says otherwise. */
  recipe?: () => Promise<ResolvedRecipe>;
  /** Recorded on the approval. A waiver is never anonymous, and neither is this. */
  by: string;
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
  onSha?: string;
  /**
   * Why. Optional only while every gate on the sha agrees: an approval over a
   * gate that still refuses is a waiver of it, and is refused without one
   * (#150). See `refusingOn`.
   */
  note?: string;
  token?: TokenSource;
  home?: string;
  gitEnv?: NodeJS.ProcessEnv;
  store?: EventStore;
  log?: (line: string) => void;
}

export type ApproveResult =
  | { ok: true; workItemId: string; runId: string; mergeCommit: string }
  | { ok: false; workItemId: string; reason: string; detail: string };

export async function approve(options: ApproveOptions): Promise<ApproveResult> {
  const workItemId = workItemStream(options.project, options.issue);
  // Held through the merge and the append that ends it, so a requeue cannot
  // put the item back in the queue while this is landing it. See `deciding`.
  return deciding<ApproveResult>(
    workItemId,
    () => ({
      ok: false,
      workItemId,
      reason: "busy",
      detail: `${workItemId} is being decided by someone else right now. Nothing was merged — reload and read it again.`,
    }),
    () => approveHolding(options, workItemId),
  );
}

async function approveHolding(options: ApproveOptions, workItemId: string): Promise<ApproveResult> {
  const store = options.store ?? eventStore;
  const log = options.log ?? (() => {});

  const item = reduceWorkItem(await store.read(workItemId));
  const runId = item.runs[item.runs.length - 1];
  if (!runId) {
    return { ok: false, workItemId, reason: "no-run", detail: `${workItemId} has never been run` };
  }

  const run = reduceRun(await store.read(runId));
  if (run.lifecycle.status !== "awaiting-approval") {
    // Including "already merged". Saying which state it is in is more useful
    // than saying it is not the right one.
    return {
      ok: false,
      workItemId,
      reason: "not-awaiting-approval",
      detail: `${runId} is ${run.lifecycle.status}, not waiting for approval`,
    };
  }

  // **The item has to be holding this run, too** (#150). Requeue is offered
  // beside Approve now, so a card left open in a second tab — or `lingtai
  // approve` — can arrive after a person sent the ticket back for a new run.
  // The run alone cannot say so; the item can.
  if (item.lifecycle.status !== "blocked" || (item.lifecycle.runId !== null && item.lifecycle.runId !== runId)) {
    return {
      ok: false,
      workItemId,
      reason: "not-blocked",
      detail: `${workItemId} is ${item.lifecycle.status}, not held on ${runId} — nothing was merged`,
    };
  }

  const { gate, onSha } = run.lifecycle;
  const branch = `agent/${options.issue}`;


  if (options.onSha && options.onSha !== onSha) {
    return {
      ok: false,
      workItemId,
      reason: "stale",
      detail:
        `the card showed ${options.onSha.slice(0, 7)} and the run is now asking about ` +
        `${onSha.slice(0, 7)}. Nothing was merged — reload and read it again.`,
    };
  }

  // **Approve absorbs the waiver** (#150). Waiving was a second click that
  // recorded a sentence and changed nothing about what this function then did,
  // so the path that explained itself cost twice the one that did not. Now a
  // refusal still standing on this sha is waived here, in the same append as
  // the approval, and there is no way past it without saying why.
  const refusing = refusingOn(run, onSha);
  const note = options.note?.trim() ?? "";
  if (refusing.length > 0 && !note) {
    return {
      ok: false,
      workItemId,
      reason: "reason-required",
      detail:
        `${refusing.join(", ")} still ${refusing.length === 1 ? "refuses" : "refuse"} ${onSha.slice(0, 7)}, ` +
        `so approving waives ${refusing.length === 1 ? "it" : "them"} — say why. Nothing was merged.`,
    };
  }

  // The check that makes the approval mean anything. A verdict is about a diff,
  // and between the hold and now someone may have pushed to this branch —
  // including the agent, on a re-run. Merging then would land something no
  // person ever looked at, which is exactly what the old label-based approval
  // did and why `onSha` exists.
  const remoteHead = await options.client.refSha(`heads/${branch}`).catch(() => null);
  if (remoteHead !== onSha) {
    return {
      ok: false,
      workItemId,
      reason: "stale",
      detail:
        `the approval is for ${onSha.slice(0, 7)} and ${branch} is now ` +
        `${remoteHead?.slice(0, 7) ?? "gone"}. Nothing was merged.`,
    };
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
  let end: readonly GateAction[];
  try {
    const recipe = await (
      options.recipe ??
      (() => resolveLocalRecipe(options.project, { base: options.base, signedIn: signedInHere }))
    )();
    end = recipe.recipe.gates.end;
  } catch (err) {
    return {
      ok: false,
      workItemId,
      reason: "recipe",
      detail: `${(err as Error).message}. Nothing was merged.`,
    };
  }

  // At the version read above, so a run that moved since it was read — a
  // second approval, a re-request on a new head — is not approved unread.
  try {
    await store.append(runId, run.version, [
      // One waiver per refusing gate, each under the name the run recorded it
      // with, carrying the approval's own reason — before the approval, so the
      // fold reads the refusal overruled and then the diff approved.
      ...refusing.map((key) => ({
        type: "GateWaived" as const,
        actor: options.by,
        data: parsePayload("GateWaived", { ...splitGate(key), runId, onSha, by: options.by, reason: note }),
      })),
      {
        type: "ApprovalGranted",
        // The approver *is* the actor. `by` is already `human:<id>`, which is the
        // shape the envelope demands, and recording it in both places keeps the
        // payload readable without the two ever disagreeing.
        actor: options.by,
        data: parsePayload("ApprovalGranted", {
          ...splitGate(gate),
          runId,
          onSha,
          by: options.by,
          note,
        }),
      },
    ]);
  } catch (err) {
    if (!(err instanceof ConcurrencyError)) throw err;
    return {
      ok: false,
      workItemId,
      reason: "stale",
      detail: `${runId} moved while this was being approved. Nothing was merged — reload and read it again.`,
    };
  }
  if (refusing.length > 0) log(`waived ${refusing.join(", ")} on ${onSha.slice(0, 7)}: ${note}`);
  log(`approved ${onSha.slice(0, 7)} by ${options.by}`);

  const merged = await integrate({
    project: options.project,
    owner: options.client.owner,
    repo: options.client.repo,
    base: options.base,
    branch,
    workItemId,
    headSha: onSha,
    // The gates already ran and their verdicts are on the log against this same
    // sha. A person approving a red build is granting a waiver, and the log
    // shows both the failure and the approval rather than one hiding the other.
    gatesPassed: true,
    token: options.token,
    home: options.home,
    gitEnv: options.gitEnv,
    store,
  });

  if (!merged.ok) {
    /**
     * **This is the dead end `#84` is about.**
     *
     * The approval has been consumed — `ApprovalGranted` is three lines above —
     * and the run is back to `gating`, which `approve()` refuses. No command
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
    const blocked = await store.read(workItemId);
    const question = `${merged.reason}: ${merged.detail.slice(0, 400)}`;
    // Beside the question, the same reading of the refusal `run-once`'s merge
    // lane writes — from the one function, so an approval that failed and a pass
    // that failed cannot describe the same conflict differently (#83).
    const diagnosis = diagnoseRefusal({
      reason: merged.reason,
      detail: merged.detail,
      branch,
      base: options.base,
    });
    const ended = resolveEndActions(blocked, end, "blocked");
    await store.append(workItemId, blocked.length, [
      {
        type: "WorkItemBlocked",
        actor: "conductor",
        data: parsePayload("WorkItemBlocked", {
          question,
          needsFrom: "human",
          runId,
          // The approval was spent and the merge still failed. Nothing is being
          // asked of anybody's judgement — this is a failure to acknowledge,
          // and the diagnosis carries the move that is left.
          needs: "acknowledgement",
          diagnosis,
        }),
      },
      ...ended,
    ]);
    await tellGitHubAbout({ store, github: options.client, workItemId, question, labels: labelsFor("waiting"), appended: ended });
    return { ok: false, workItemId, reason: merged.reason, detail: merged.detail };
  }

  const landed = await store.read(workItemId);
  // The same append, so an item cannot land without its `end` point being
  // resolved in the same transaction.
  const ended = resolveEndActions(landed, end, "landed");
  await store.append(workItemId, landed.length, [
    {
      type: "WorkItemLanded",
      actor: "conductor",
      data: parsePayload("WorkItemLanded", { mergeCommit: merged.mergeCommit, base: options.base }),
    },
    ...ended,
  ]);
  await tellGitHubAbout({
    store,
    github: options.client,
    workItemId,
    labels: labelsFor("landed"),
    appended: ended,
  });
  log(`landed ${merged.mergeCommit.slice(0, 7)} on ${options.base}`);
  return { ok: true, workItemId, runId, mergeCommit: merged.mergeCommit };
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
 * The move is not a new mechanism. `WorkItemUnblocked` has been in the
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
  project: string;
  issue: number;
  by: string;
  /** Why, on the record. A person overruling a block is not anonymous either. */
  note: string;
  /**
   * What to do with a question asked before any run: withdraw it (the default,
   * `lingtai requeue` and the board's Withdraw), or refuse. The board's Send
   * refuses — it checks first, but a `lingtai ask` landing between that check
   * and this read would otherwise be withdrawn under a note about a document.
   */
  onQuestion?: "withdraw" | "refuse";
  store?: EventStore;
}): Promise<{ ok: boolean; workItemId: string; detail: string }> {
  const store = options.store ?? eventStore;
  const workItemId = workItemStream(options.project, options.issue);

  // **Never while an approval is acting on the item** (#150). Requeue sits
  // beside Approve now, and an approval that has appended and is still merging
  // leaves the item `blocked` for seconds; unblocking it then let the diff land
  // on an item a new run had claimed. The run is left as it is: an approval
  // that arrives after this reads the item, which is no longer holding it. See
  // `deciding`.
  return deciding(
    workItemId,
    () => ({
      ok: false,
      workItemId,
      detail: `${workItemId} is being decided by someone else right now — an approval may be merging it. Reload and read it again`,
    }),
    () => requeueHolding(options, store, workItemId),
  );
}

async function requeueHolding(
  options: { by: string; note: string; onQuestion?: "withdraw" | "refuse" },
  store: EventStore,
  workItemId: string,
): Promise<{ ok: boolean; workItemId: string; detail: string }> {
  const events = await store.read(workItemId);
  const item = reduceWorkItem(events);
  if (item.lifecycle.status !== "blocked") {
    // Saying which state it is in, for the reason `approve` does: "not blocked"
    // sends somebody nowhere, and "it is already running" answers the question.
    return {
      ok: false,
      workItemId,
      detail: `${workItemId} is ${item.lifecycle.status}, not blocked`,
    };
  }
  // **A block no run holds is a question about the ticket (#147), and a requeue
  // withdraws it rather than answering it.** The fold keeps whatever note ends
  // such a block as a decision and carries it into every later prompt
  // (`answersBrief`), so a requeue's why — *asked by mistake, ignore* — is
  // written `withdrawn`, which the fold keeps nothing of. Answering is
  // `answer()`'s. Refusing here instead left a mistaken question no way out
  // but an answer every attempt would be told.
  const withdrawn = item.lifecycle.runId === null;
  if (withdrawn && options.onQuestion === "refuse") {
    return {
      ok: false,
      workItemId,
      detail: `${workItemId} is asking a question before any run — answer it first`,
    };
  }

  await store.append(workItemId, item.version, [
    {
      type: "WorkItemUnblocked",
      actor: options.by,
      data: parsePayload("WorkItemUnblocked", {
        by: options.by,
        note: options.note,
        ...(withdrawn ? { withdrawn: true } : {}),
      }),
    },
  ]);

  return {
    ok: true,
    workItemId,
    detail: withdrawn
      ? `question withdrawn, by ${options.by} — back in the queue, and no attempt is told it`
      : `back in the queue, by ${options.by}`,
  };
}

/**
 * Waiving a gate: merging past a verdict, on the record.
 *
 * **A waiver is never silent.** It records who and why, and both go on the
 * card. That is the entire difference between this and the thing it replaces —
 * a person deciding "the build failure is unrelated, land it" is legitimate and
 * happens; a person doing it by deleting a label and telling nobody is how a
 * system stops being able to explain itself.
 *
 * Bound to the sha like every other verdict. A waiver for a commit that is no
 * longer the head stops counting the moment the branch moves, without anyone
 * revoking it.
 */
export async function waive(options: {
  project: string;
  issue: number;
  gate: string;
  by: string;
  reason: string;
  onSha?: string;
  store?: EventStore;
}): Promise<{ ok: boolean; workItemId: string; detail: string }> {
  const store = options.store ?? eventStore;
  const workItemId = workItemStream(options.project, options.issue);

  if (!options.reason.trim()) {
    // The one rule. A waiver with no reason is the silent waiver by another
    // name, and the field being present is not the same as it being filled in.
    return { ok: false, workItemId, detail: "a waiver needs a reason" };
  }

  const item = reduceWorkItem(await store.read(workItemId));
  const runId = item.runs[item.runs.length - 1];
  if (!runId) return { ok: false, workItemId, detail: `${workItemId} has never been run` };

  const events = await store.read(runId);
  const run = reduceRun(events);
  if (!run.headSha) return { ok: false, workItemId, detail: `${runId} has produced no diff to waive` };

  // **A waiver names a gate the run reported, or it is refused** (#150). The
  // board's card once sent `"build"` for whatever had refused, so a waived
  // `review` was recorded as a waived `build` — a verdict about a gate that
  // never said anything. Reported means a verdict on any sha, or a place in the
  // run's last `GatesResolved` plan: `lingtai waive` exists to close a planned
  // gate that never reported, and `end` is left out because it has no verdict.
  const plan = events.filter((e) => e.type === "GatesResolved").at(-1);
  const planned = plan
    ? parsePayload("GatesResolved", plan.data).points.flatMap((p) =>
        p.gate === "end" ? [] : p.actions.map((a) => `${p.gate}:${a}`),
      )
    : [];
  if (!run.gates[options.gate] && !planned.includes(options.gate)) {
    return {
      ok: false,
      workItemId,
      detail: `${runId} reported no gate named "${options.gate}" — a waiver can only name one it did`,
    };
  }

  // The sha the person was looking at, when they said so. If the branch has
  // moved since the card rendered, they are waiving something they have not
  // seen.
  if (options.onSha && options.onSha !== run.headSha) {
    return {
      ok: false,
      workItemId,
      detail: `the card showed ${options.onSha.slice(0, 7)} and the branch is now ${run.headSha.slice(0, 7)}`,
    };
  }

  await store.append(runId, run.version, [
    {
      type: "GateWaived",
      actor: options.by,
      data: parsePayload("GateWaived", {
        ...splitGate(options.gate),
        runId,
        onSha: run.headSha,
        by: options.by,
        reason: options.reason,
      }),
    },
  ]);

  return {
    ok: true,
    workItemId,
    detail: `${options.gate} waived on ${run.headSha.slice(0, 7)} by ${options.by}: ${options.reason}`,
  };
}
