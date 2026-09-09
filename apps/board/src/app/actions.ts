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
import { approve, reject, requeue, waive } from "@lingtai/conductor/decide";
import { concludeDiscussion, type IssueChannel } from "@lingtai/conductor/discuss";
import { CONTROL_STREAM, parsePayload, parseWorkItemStream } from "@lingtai/domain";
import { eventStore } from "@lingtai/event-store";
import { randomUUID } from "node:crypto";
import { loadProject } from "@lingtai/conductor/projects";
import { resumeConductor } from "@lingtai/daemon/control";
import { stateDir } from "@lingtai/env";
import { git } from "@lingtai/repo";
import { githubApp, hasGitHubApp } from "@lingtai/env";
import { createGitHubClient } from "@lingtai/github";
import { revalidatePath } from "next/cache";
// A "use server" module may only export async functions, so the shapes and the
// limit live next door.
import { DIFF_FILE_LIMIT, type ActionResult, type DiffFile, type DiffResult } from "@/lib/diff";
import { userInfo } from "node:os";

/**
 * Who is acting.
 *
 * The local account, because the board runs on one machine for one person
 * (0007). A weak claim, but a true one, and an approval that recorded nobody
 * would be the silent waiver this system exists to remove.
 */
function actor(): string {
  return `human:${userInfo().username}`;
}

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
