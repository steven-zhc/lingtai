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
 * This is a stopgap with a known shape. It is the CLI half of #21 — approve and
 * reject on the board — and when that lands the two must become one path rather
 * than two vocabularies for one idea. What is here is what makes `--no-merge`
 * mean something before then.
 */
import { type GateAction, resolveRecipe } from "@lingtai/recipe";
import { parsePayload, reduceRun, reduceWorkItem } from "@lingtai/domain";
import type { GitHubClient } from "@lingtai/github";
import { type EventStore, eventStore } from "@lingtai/event-store";
import { workItemStream } from "@lingtai/domain";
import { releaseWorkItem } from "./claim.ts";
import { appendEndActions, resolveEndActions } from "./end-point.ts";
import { labelsFor } from "./labels.ts";
import { decideRepair, type RepairPolicy } from "./repair.ts";
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
  note?: string;
  /** Withdraws an approval instead of granting one. See `reject` below. */
  revoke?: { reason: string };
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
  let end: readonly GateAction[];
  let repairPolicy: RepairPolicy;
  try {
    const recipe = await resolveRecipe((p, r) => options.client.fileAt(p, r), options.base);
    end = recipe.recipe.gates.end;
    // From the same read, because this is the path the two stuck items took: an
    // approval is granted, the merge hits a conflict, and the approval has been
    // consumed. Whether that failure buys an agent is the recipe's, and this is
    // where it has to be known.
    repairPolicy = recipe.recipe.repair;
  } catch (err) {
    return {
      ok: false,
      workItemId,
      reason: "recipe",
      detail: `${(err as Error).message}. Nothing was merged.`,
    };
  }

  await store.append(runId, run.version, [
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
        note: options.note ?? "",
      }),
    },
  ]);
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
     * So the failure gets an outcome rather than a headstone: if it belongs to
     * the managed repository and the bound is not spent, it buys an agent and
     * the item goes back to the queue as a repair — which ends by requesting
     * approval on the head it produced. If it does not, the block carries the
     * reason no agent was bought, so the card has a sentence and a move instead
     * of a control that refuses.
     */
    const failed = await store.read(workItemId);
    const decision = decideRepair({
      failure: { source: "integration", reason: merged.reason, detail: merged.detail },
      policy: repairPolicy,
      item: reduceWorkItem(failed),
      runId,
    });

    if (decision.repair) {
      // Recorded then released, in that order: the fold carries a pending
      // repair between the two and the next claim is it.
      await store.append(workItemId, failed.length, [
        {
          type: "RepairRequested",
          actor: "conductor",
          data: parsePayload("RepairRequested", {
            runId,
            reason: merged.reason,
            detail: merged.detail.slice(0, 4_000),
            fingerprint: decision.fingerprint,
            attempt: decision.attempt,
          }),
        },
      ]);
      const reason = `repairing ${merged.reason} (attempt ${decision.attempt})`;
      await releaseWorkItem(workItemId, runId, reason, store);
      // On its own append, because the release owns the one above — the same
      // shape `run-once`'s release uses, and for the same reason.
      const ended = await appendEndActions(store, workItemId, end, "failed");
      await tellGitHubAbout({
        store,
        github: options.client,
        workItemId,
        labels: labelsFor("queued"),
        appended: ended,
      });
      log(`bought a repair for ${merged.reason} — attempt ${decision.attempt}`);
      // The merge did not happen, so this is a refusal — but the operator has
      // to be told that something is going to be done about it, or the button
      // reads as the dead end it used to be.
      return {
        ok: false,
        workItemId,
        reason: merged.reason,
        detail:
          `${merged.detail}\n\nNothing was merged. A repair was bought (attempt ` +
          `${decision.attempt}); it will come back asking you to approve its diff.`,
      };
    }

    const blocked = await store.read(workItemId);
    const question = `${merged.reason}: ${merged.detail.slice(0, 400)} — no repair: ${decision.why}`;
    const ended = resolveEndActions(blocked, end, "blocked");
    await store.append(workItemId, blocked.length, [
      {
        type: "RepairDeclined",
        actor: "conductor",
        data: parsePayload("RepairDeclined", {
          runId,
          reason: merged.reason,
          detail: merged.detail.slice(0, 4_000),
          fingerprint: decision.fingerprint,
          why: decision.why,
        }),
      },
      {
        type: "WorkItemBlocked",
        actor: "conductor",
        data: parsePayload("WorkItemBlocked", { question, needsFrom: "human", runId }),
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
 * Withdrawing an approval, or refusing to give one.
 *
 * The item goes **back to the gate**, not back to the queue. The question is
 * open again and the answer is still a person's; returning it to the queue
 * would let another run claim it and throw the question away.
 *
 * Nothing is merged and nothing is deleted. The branch stays where it is, and
 * the log carries both the request and the withdrawal — which is the whole
 * reason a rejection is an event rather than a label being removed.
 */
export async function reject(
  options: Omit<ApproveOptions, "revoke"> & { reason: string },
): Promise<{ ok: boolean; workItemId: string; detail: string }> {
  const store = options.store ?? eventStore;
  const workItemId = workItemStream(options.project, options.issue);

  const item = reduceWorkItem(await store.read(workItemId));
  const runId = item.runs[item.runs.length - 1];
  if (!runId) return { ok: false, workItemId, detail: `${workItemId} has never been run` };

  const run = reduceRun(await store.read(runId));
  if (run.lifecycle.status !== "awaiting-approval") {
    return {
      ok: false,
      workItemId,
      detail: `${runId} is ${run.lifecycle.status}, not waiting for approval`,
    };
  }


  const { gate, onSha } = run.lifecycle;
  await store.append(runId, run.version, [
    {
      type: "ApprovalRevoked",
      actor: options.by,
      data: parsePayload("ApprovalRevoked", { ...splitGate(gate), runId, onSha, by: options.by, reason: options.reason }),
    },
  ]);

  return { ok: true, workItemId, detail: `${gate} on ${onSha.slice(0, 7)} was withdrawn by ${options.by}` };
}

/**
 * Putting a blocked item back in the queue: the move that is left when there is
 * no diff to approve.
 *
 * **A card must never offer only a control that refuses.** That is the `#84`
 * complaint stated as a rule: an item whose integration failed and whose repair
 * was declined — because the recipe says the project does not repair, or
 * because the ceiling is spent — is `blocked` with a question, its run is
 * `gating`, and `approve()` will not touch it. Before this, the board rendered
 * Approve on it anyway and the button could not work.
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
