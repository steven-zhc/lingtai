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
 * The board's Approve and `lingtai approve` are this one function, so the two
 * cannot become two vocabularies for one idea.
 *
 * **There is no Reject** (#150). It appended `ApprovalRevoked`, which folds the
 * run straight back to `awaiting-approval` — a person pressed it twice, 46
 * seconds apart, and the card could not move. The move somebody who agrees with
 * a refusal wants is `requeue`, and it is offered beside Approve on every
 * blocked card. `ApprovalRevoked` stays in the catalogue so the log that has it
 * still folds; nothing appends it.
 */
import { type GateAction, resolveRecipe } from "@lingtai/recipe";
import { parsePayload, reduceRun, reduceWorkItem, type GateState, type RunState } from "@lingtai/domain";
import type { GitHubClient } from "@lingtai/github";
import { type EventStore, eventStore } from "@lingtai/event-store";
import { workItemStream } from "@lingtai/domain";
import { resolveEndActions } from "./end-point.ts";
import { labelsFor } from "./labels.ts";
import { diagnoseRefusal } from "./attribution.ts";
import { tellGitHubAbout } from "./tell.ts";
import { integrate, type TokenSource } from "@lingtai/repo";

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

export interface ApproveOptions {
  project: string;
  issue: number;
  base: string;
  client: GitHubClient;
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
   * Why. Optional only where nothing is refusing: when a gate on the sha still
   * refuses it, this is the waiver's reason and an approval without one is
   * refused (`refusingGates`).
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

/**
 * The gates still refusing the sha an approval is about.
 *
 * **Read off the run, never named by a caller** (#150). The board's Waive sent
 * `gates[0] ?? "build"`, and the home board passed the literal `["build"]` — so
 * a waived `review` was recorded as a waived `build`. There is no parameter
 * here for a caller to get wrong.
 *
 * `failed` and `never-ran` are the two verdicts that stand between a diff and
 * the merge; a `requested` one is the approval itself. `end` runs for effect
 * and has no verdict to be past.
 */
export function refusingGates(run: RunState, onSha: string): GateState[] {
  return Object.values(run.gates).filter(
    (g) =>
      g.onSha === onSha &&
      (g.verdict === "failed" || g.verdict === "never-ran") &&
      splitGate(g.gate).gate !== "end",
  );
}

/**
 * The `GateWaived` Approve appends for each gate still refusing `onSha` — and
 * the payload `waive()` appends for one, field for field, so a waiver taken on
 * the board and one taken with `lingtai waive` cannot be told apart.
 */
export function waiversOver(input: { run: RunState; runId: string; onSha: string; by: string; reason: string }) {
  return refusingGates(input.run, input.onSha).map((g) => ({
    type: "GateWaived" as const,
    actor: input.by,
    data: parsePayload("GateWaived", {
      ...splitGate(g.gate),
      runId: input.runId,
      onSha: input.onSha,
      by: input.by,
      reason: input.reason,
    }),
  }));
}

export async function approve(options: ApproveOptions): Promise<ApproveResult> {
  const store = options.store ?? eventStore;
  const log = options.log ?? (() => {});
  const workItemId = workItemStream(options.project, options.issue);

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

  // **Approve absorbs the waiver** (#150). `approve()` used to read no verdict
  // at all, so Waive-then-Approve and Approve alone merged the same diff, and
  // the path that explained itself cost a second click. Now a merge over a live
  // refusal is one action that cannot be taken without a reason, and the reason
  // is recorded as a `GateWaived` on each refusing gate — the same event, on the
  // same stream, that `gate-audit` and `attempts` already read.
  const refusing = refusingGates(run, onSha);
  const note = options.note?.trim() ?? "";
  if (refusing.length > 0 && note === "") {
    const names = refusing.map((g) => `${g.gate} (${g.verdict})`).join(", ");
    return {
      ok: false,
      workItemId,
      reason: "unexplained",
      detail:
        `${names} still refuses ${onSha.slice(0, 7)}. Approving merges over it, so it needs a ` +
        `reason, recorded as the waiver. Nothing was merged.`,
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
  // From origin/<base>, the same rule every other read of a recipe follows
  // (0005) — never from the agent's branch, which is the thing being judged.
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
    const recipe = await resolveRecipe((p, r) => options.client.fileAt(p, r), options.base);
    end = recipe.recipe.gates.end;
  } catch (err) {
    return {
      ok: false,
      workItemId,
      reason: "recipe",
      detail: `${(err as Error).message}. Nothing was merged.`,
    };
  }

  // One append, so an approval over a refusal cannot land without its waivers.
  await store.append(runId, run.version, [
    ...waiversOver({ run, runId, onSha, by: options.by, reason: note }),
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
  for (const g of refusing) log(`waived ${g.gate} on ${onSha.slice(0, 7)} by ${options.by}: ${note}`);
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
    // sha. A person approving a red build has granted a waiver — appended above,
    // with its reason — and the log shows the failure, the waiver and the
    // approval rather than one hiding another.
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
 * Putting a blocked item back in the queue: the move that is left when there is
 * no diff to approve.
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
  store?: EventStore;
}): Promise<{ ok: boolean; workItemId: string; detail: string }> {
  const store = options.store ?? eventStore;
  const workItemId = workItemStream(options.project, options.issue);

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

  await store.append(workItemId, item.version, [
    {
      type: "WorkItemUnblocked",
      actor: options.by,
      data: parsePayload("WorkItemUnblocked", { by: options.by, note: options.note }),
    },
  ]);

  return { ok: true, workItemId, detail: `back in the queue, by ${options.by}` };
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
 *
 * **It merges nothing, and the board no longer offers it** (#150): a button
 * that recorded a sentence and changed nothing Approve would do was a comment
 * wearing a control's clothes. On the board a waiver is what Approve appends
 * over a live refusal. `lingtai waive` still calls this, for a verdict a person
 * wants on the record without merging — and says so after it appends.
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

  const run = reduceRun(await store.read(runId));
  if (!run.headSha) return { ok: false, workItemId, detail: `${runId} has produced no diff to waive` };

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
