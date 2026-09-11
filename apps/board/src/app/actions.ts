"use server";

/**
 * What a person can do from the board.
 *
 * Three of them decide a card — approve, reject, waive — and one decides the
 * whole installation: resume. They are the same shape, which is the point.
 *
 * This is the ticket the whole project is a bet on. The old review queue
 * reached 45 items growing at 14 a day against zero processed, and the reason
 * was not that nobody cared — it was that working an item meant leaving the
 * tool, finding the branch, reading the diff somewhere else, and coming back.
 * If these three actions ship and that number does not move, the bottleneck was
 * never tooling, which is worth knowing.
 *
 * Each one appends an event and nothing else. There is no board-specific state
 * and no second write path: `approve` here is the same `approve` that
 * `lingtai approve` calls, which is what stops the two from drifting into two
 * systems that disagree about what happened.
 *
 * **Every action carries the sha the card was showing.** A person approves a
 * diff, not a ticket, and between the card rendering and the click the branch
 * can move. The server compares and refuses rather than acting on something
 * nobody looked at — the same reason `onSha` exists on every verdict.
 */
// Subpaths, not the barrel. The root export pulls in `run-once`, which pulls
// in the gates and the runtime, which the board has no business compiling —
// the same reason `./board` and `./projects` exist.
import { actor, approve, reject, requeue, waive } from "@lingtai/conductor/decide";
import { concludeDiscussion, type IssueChannel } from "@lingtai/conductor/discuss";
import { editHash } from "@lingtai/conductor/prompt";
import { CONTROL_STREAM, parsePayload, parseWorkItemStream, workItemStream } from "@lingtai/domain";
import { eventStore } from "@lingtai/event-store";
import { randomUUID } from "node:crypto";
import { loadProject } from "@lingtai/conductor/projects";
import { requestRun, resumeConductor } from "@lingtai/daemon/control";
import { stateDir } from "@lingtai/env";
import { git } from "@lingtai/repo";
import { githubApp, hasGitHubApp } from "@lingtai/env";
import { createGitHubClient } from "@lingtai/github";
import { revalidatePath } from "next/cache";
// A "use server" module may only export async functions, so the shapes and the
// limit live next door.
import { DIFF_FILE_LIMIT, type ActionResult, type DiffFile, type DiffResult } from "@/lib/diff";

// `actor()` is imported beside the decisions rather than spelled here, so that
// "a waiver from the terminal is indistinguishable from one from a card" (#129)
// is one function and not two files that agree today.

async function project(name: string) {
  const state = await loadProject(name);
  if (!state?.owner) throw new Error(`no project named "${name}" — run lingtai add first`);
  return state;
}

export async function approveCard(input: {
  project: string;
  issue: number;
  onSha: string;
  note?: string;
}): Promise<ActionResult> {
  try {
    if (!hasGitHubApp()) return { ok: false, detail: "no GitHub App configured" };
    const state = await project(input.project);
    const client = await createGitHubClient({
      auth: githubApp(),
      owner: state.owner!,
      repo: input.project,
    });

    const result = await approve({
      project: input.project,
      issue: input.issue,
      base: state.base ?? (await client.defaultBranch()),
      client,
      by: actor(),
      // The sha the card was offering, which is the one the run is *asking*
      // about (`task_view.awaiting_sha`) and not the one it produced. Checked
      // server-side against the run's own `onSha`, so a click on a card the log
      // has moved past refuses instead of approving a diff nobody read — and a
      // card that is current agrees with `lingtai approve` rather than refusing
      // what the CLI accepts (#92).
      onSha: input.onSha,
      note: input.note,
      token: () => client.token(),
    });

    revalidatePath("/");
    return result.ok
      ? { ok: true, detail: `landed ${result.mergeCommit.slice(0, 7)}` }
      : { ok: false, detail: `${result.reason}: ${result.detail}` };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

export async function rejectCard(input: {
  project: string;
  issue: number;
  onSha: string;
  reason: string;
}): Promise<ActionResult> {
  try {
    if (!input.reason.trim()) return { ok: false, detail: "a rejection needs a reason" };
    const state = await project(input.project);
    const client = await createGitHubClient({
      auth: githubApp(),
      owner: state.owner!,
      repo: input.project,
    });

    const result = await reject({
      project: input.project,
      issue: input.issue,
      base: state.base ?? (await client.defaultBranch()),
      client,
      by: actor(),
      onSha: input.onSha,
      reason: input.reason,
    });

    revalidatePath("/");
    return { ok: result.ok, detail: result.detail };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

/**
 * Back to the queue, for a card that has nothing to approve.
 *
 * The fourth card action, and the one `#84` is about: an item whose approved
 * merge failed is `blocked` with its run back at `gating`, so Approve refuses
 * every click. This is the move it actually has — the next attempt is cut from
 * a base that has since moved.
 *
 * No `onSha`, and that is not an oversight. The other three agree to a specific
 * diff; this one throws the diff away and asks for another, which is a decision
 * about the *ticket*. A stale sha is the reason to do it, not a reason to
 * refuse.
 */
export async function requeueCard(input: {
  project: string;
  issue: number;
  note: string;
}): Promise<ActionResult> {
  try {
    if (!input.note.trim()) return { ok: false, detail: "say why, so the log can" };
    const result = await requeue({
      project: input.project,
      issue: input.issue,
      by: actor(),
      note: input.note,
    });

    revalidatePath("/");
    return { ok: result.ok, detail: result.detail };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

export async function waiveGate(input: {
  project: string;
  issue: number;
  gate: string;
  onSha: string;
  reason: string;
}): Promise<ActionResult> {
  try {
    const state = await project(input.project);
    const result = await waive({
      project: input.project,
      issue: input.issue,
      gate: input.gate,
      by: actor(),
      reason: input.reason,
      // Checked server-side: the branch may have moved since the card rendered.
      onSha: input.onSha,
    });

    revalidatePath("/");
    return { ok: result.ok, detail: result.detail };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

/**
 * Lift the pause, from the chip that reports it.
 *
 * An append and nothing else, exactly like `lingtai resume` — this does not
 * start a daemon and does not reach into a pass already in flight. Whatever is
 * hosting the work asks the log every pass, so a resume issued while nothing
 * is running is waiting when something starts (0013).
 *
 * No `onSha`, because there is no diff being agreed to: the thing being
 * decided is the conductor, and it has one state.
 */
export async function resumeWork(): Promise<ActionResult> {
  try {
    const by = actor();
    await resumeConductor(by);
    revalidatePath("/");
    return { ok: true, detail: `resumed by ${by}` };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

/**
 * Ask the discussion assistant a question about this item.
 *
 * An append to `ctl-conductor` and nothing else — the same stream `pause` and
 * `now` use, and for the reason [0013] gives: **the UI controls, the daemon
 * holds** ([0033](../../../../doc/decisions/0033-the-third-kind-of-agent.md)
 * §3). The board does not start an agent. It is arguable the other way, since
 * two of 0013's three reasons do not apply to something with no worktree and no
 * claim; what decides it is the third, that this spends money, and everything
 * that spends money starts where the accounting already is.
 *
 * So a question asked while the daemon is down is *waiting* when it comes back
 * rather than failing here, which is the behaviour a person actually wants.
 *
 * `chatId` continues an existing conversation; omitting it opens a new one. No
 * `onSha`, because nothing is being agreed to: a question is about what
 * happened, not about which diff to merge.
 */
export async function askDiscussion(input: {
  taskId: string;
  /** The attempt being asked about, or null for the item as a whole. */
  attempt: number | null;
  question: string;
  chatId?: string;
}): Promise<ActionResult & { chatId?: string }> {
  try {
    if (!input.question.trim()) return { ok: false, detail: "a question needs a question" };
    const chatId = input.chatId ?? `chat-${randomUUID()}`;
    const by = actor();
    const events = await eventStore.read(CONTROL_STREAM);
    await eventStore.append(CONTROL_STREAM, events.length, [
      {
        type: "DiscussionRequested",
        actor: by,
        data: parsePayload("DiscussionRequested", {
          chatId,
          workItemId: input.taskId,
          attempt: input.attempt,
          question: input.question,
          by,
        }),
      },
    ]);

    revalidatePath(`/task/${input.taskId}`);
    return { ok: true, detail: "asked — the daemon answers", chatId };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

/**
 * Close a discussion, with the artefact it produced or with none.
 *
 * **Two outputs and only two** (0033 §2). `prompt` appends `PromptEdited`,
 * which the next claim consumes and discards; `ticket` appends the sentence to
 * the GitHub issue body, where it versions as `ticket@NNNN` and every later
 * attempt reads it. `none` is the ordinary ending: a question answered that
 * needed nothing written down.
 *
 * The ticket's body is read here, immediately before it is written, because
 * GitHub offers a replace and not an append — the same read-modify-write
 * `setLabels` has to do, and for the same reason.
 */
export async function concludeChat(input: {
  taskId: string;
  chatId: string;
  outcome: "prompt" | "ticket" | "none";
  text: string;
}): Promise<ActionResult> {
  try {
    const parsed = parseWorkItemStream(input.taskId);
    if (!parsed) return { ok: false, detail: "this id is not a work item" };

    let ticket: { github: IssueChannel; body: string } | undefined;
    if (input.outcome === "ticket") {
      const state = await project(parsed.project);
      const client = await createGitHubClient({
        auth: githubApp(),
        owner: state.owner!,
        repo: parsed.project,
      });
      const issue = await client.getIssue(Number(parsed.issue));
      ticket = { github: client, body: issue.body };
    }

    const result = await concludeDiscussion({
      store: eventStore,
      workItemId: input.taskId,
      chatId: input.chatId,
      by: actor(),
      outcome: input.outcome,
      text: input.text,
      ...(ticket === undefined ? {} : { ticket }),
    });

    revalidatePath(`/task/${input.taskId}`);
    return result;
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

/**
 * A sentence added to the next attempt's prompt — or taken back off it.
 *
 * The move `#104` exists for. Approving a blocked item was *yes* or *no*, and
 * the answer a person usually has is *yes, but*: `#89` cost two attempts and
 * $13.04 chasing a flag one editable sentence would have settled.
 *
 * **On the work item stream, never on the approval.** `approve()` binds to
 * `onSha` and a force-push voids it by arithmetic; an edit is about *what to
 * do*, not about which diff to merge, so it outlives the diff (0032 §5). Which
 * is also why there is no `onSha` in this input: nothing is being agreed to.
 *
 * **It applies to the next run only**, whoever starts it. `reduceWorkItem`
 * holds it as `pendingPrompt` and the next `WorkItemClaimed` consumes it —
 * anything meant to last belongs in the GitHub ticket, where it versions as
 * `ticket@NNNN` and everybody can see it (§6).
 *
 * An empty `text` is *Remove the edit*: the reducer clears `pendingPrompt` on a
 * blank one, so a withdrawal is an append like every other decision here rather
 * than an absence somebody has to notice.
 */
export async function editPrompt(input: {
  taskId: string;
  /** Raw. What is typed is what the attempt is told, byte for byte. */
  text: string;
  /**
   * The composed version the box was showing — `ticket@1924+failure@1c5708ba`.
   *
   * Recorded, not checked. Unlike `onSha` this is not a claim about what may
   * still be merged: the log is being told what the person was reading when
   * they wrote, and a prompt that has moved since is a difference a reader can
   * see rather than a reason to refuse.
   */
  basedOn: string;
}): Promise<ActionResult> {
  try {
    if (!parseWorkItemStream(input.taskId)) return { ok: false, detail: "this id is not a work item" };
    const text = input.text;
    const by = actor();
    const events = await eventStore.read(input.taskId);
    await eventStore.append(input.taskId, events.length, [
      {
        type: "PromptEdited",
        actor: by,
        data: parsePayload("PromptEdited", {
          text,
          // The same digest the next run's `promptVersion` will carry, from the
          // same function, so the event and the version cannot name different
          // numbers for one edit. Null on a removal: there is nothing to hash.
          hash: text.trim() === "" ? null : editHash(text),
          by,
          basedOn: input.basedOn || null,
          chatId: null,
        }),
      },
    ]);

    revalidatePath(`/task/${input.taskId}`);
    return {
      ok: true,
      detail: text.trim() === "" ? "the edit is off the next attempt" : "the next attempt carries it",
    };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

/**
 * Send the next attempt: commit the prompt, and let it be claimed.
 *
 * **The move `WILL BE SENT` had no button for.** `#104` put the composed prompt
 * on the page and made it editable, and the only controls beside it decided a
 * *diff* — so a person could compose exactly the right instruction and then had
 * `Back to the queue`, which says nothing about the document it sends. An
 * editable control with no commit action is not half a feature; it is a dead
 * end (#111), and `0032` §5's whole point is turning approval from *yes / no*
 * into *yes, but*.
 *
 * **Two appends, one click, in that order.** `PromptEdited` first — when a
 * sentence came with the click — then `WorkItemUnblocked`, which is what makes
 * the item claimable again. The order is the safe one: an edit committed
 * against an item that is still blocked is a sentence waiting for a pass that
 * may never come, and an unblock with the edit lost is the attempt running
 * without the thing it was sent for. The first failure is recoverable by
 * clicking again; the second spends an agent.
 *
 * No `onSha`. Nothing is being agreed to — the same reading `requeue` makes, one
 * door along: a stale sha is the *reason* to send another attempt, not a reason
 * to refuse.
 */
export async function sendAttempt(input: {
  taskId: string;
  /**
   * A sentence to commit before sending, or null to send what is standing.
   *
   * Null from the decision row, which sends the prompt as the box shows it —
   * `pendingPrompt` included, if an earlier *Add to attempt N* put one there.
   * A string from the editor's own Send, so text typed and not staged is not
   * silently dropped by the click that was meant to send it.
   */
  text?: string | null;
  /** The composed version the box was showing. See `editPrompt`. */
  basedOn?: string | null;
}): Promise<ActionResult> {
  try {
    const parsed = parseWorkItemStream(input.taskId);
    if (!parsed) return { ok: false, detail: "this id is not a work item" };

    const by = actor();
    if (typeof input.text === "string" && input.text.trim() !== "") {
      const edited = await editPrompt({
        taskId: input.taskId,
        text: input.text,
        basedOn: input.basedOn ?? "",
      });
      // Refused: nothing is unblocked, and the sentence is still in the box.
      if (!edited.ok) return edited;
    }

    const result = await requeue({
      project: parsed.project,
      issue: Number(parsed.issue),
      by,
      // The system's own sentence rather than a field to fill in. `requeue`
      // wants a note because a person overruling a *block* is not anonymous;
      // here the reason is the document on screen, which is on the log already
      // — asking again would be asking somebody to restate their prompt in
      // prose.
      note: `sent as the next attempt by ${by}`,
    });

    revalidatePath(`/task/${input.taskId}`);
    revalidatePath("/");
    return { ok: result.ok, detail: result.ok ? "sent — the next pass claims it" : result.detail };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

/**
 * Take this ticket next — what `lingtai now` does, from the page.
 *
 * An append to `ctl-conductor` and nothing else, exactly like `pause` and
 * `ask`: **the UI controls, the daemon holds** (0013). The board does not start
 * a run, so a click made while the daemon is down is waiting when it comes back
 * rather than failing here.
 *
 * **It jumps the backoff, and that is the whole of the move**
 * ([0028](../../../../doc/decisions/0028-the-backoff-is-the-recipes.md) §3). The
 * guard exists to stop *blind* retries — the same ticket at the top of the
 * queue, failing the same way, at agent prices — and a person naming an issue is
 * not blind. `conduct.ts` matches a request with `backoffMs: 0` for exactly that
 * reason; every other subtraction still applies, so a request for something
 * already claimed or landed matches nothing and quietly expires.
 *
 * No `onSha`, and no note. Nothing is being agreed to and nothing is being
 * overruled: this asks for the item at the front of the queue to be this one.
 */
export async function runNow(input: { project: string; issue: string }): Promise<ActionResult> {
  try {
    const by = actor();
    await requestRun(input.project, input.issue, by);
    // The id said once, by the function that owns its shape — a second copy of
    // `wi-<project>-<n>` here is a revalidation that quietly stops matching.
    revalidatePath(`/task/${workItemStream(input.project, input.issue)}`);
    revalidatePath("/");
    return { ok: true, detail: `asked for by ${by} — the next pass takes it` };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

/**
 * The diff, read from Lingtai's own mirror.
 *
 * On demand rather than in the projection: a diff can be megabytes, projections
 * are rebuilt by replaying everything, and a card that is never expanded should
 * cost nothing. The mirror is already on this machine — the conductor cloned it
 * — so this is a local `git diff`, not a network call.
 *
 * Split per file here, on the server, because the alternative is shipping one
 * giant string and making the browser parse it on the main thread.
 */
export async function loadDiff(input: {
  project: string;
  baseSha: string;
  headSha: string;
}): Promise<DiffResult> {
  try {
    const mirror = `${stateDir()}/repos/${input.project}.git`;
    const raw = await git(["diff", `${input.baseSha}...${input.headSha}`], { cwd: mirror });

    const files: DiffFile[] = [];
    let current: DiffFile | null = null;
    for (const line of raw.split("\n")) {
      if (line.startsWith("diff --git ")) {
        // `diff --git a/x b/x` — the b-side is the path after a rename.
        const path = line.slice(line.lastIndexOf(" b/") + 3) || line.slice(11);
        current = { path, added: 0, removed: 0, lines: [] };
        files.push(current);
        continue;
      }
      if (!current) continue;
      current.lines.push(line);
      if (line.startsWith("+") && !line.startsWith("+++")) current.added += 1;
      if (line.startsWith("-") && !line.startsWith("---")) current.removed += 1;
    }

    // Bounded, and honest about it. A run that changed 300 files is a work item
    // that was scoped too large, which the card says elsewhere.
    const truncated = files.length > DIFF_FILE_LIMIT;
    return { ok: true, files: files.slice(0, DIFF_FILE_LIMIT), truncated };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}
