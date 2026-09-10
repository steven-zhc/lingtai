/**
 * The world a discussion happens in, assembled for the daemon to hold.
 *
 * The same split `conduct.ts` makes, and for the same reason: `@lingtai/daemon`
 * hosts a loop and knows nothing about GitHub clients, runtimes or mirrors, and
 * giving it those dependencies would make it the thing it is supposed to be
 * hosting. What `@lingtai/conductor/discuss` decides is what the assistant is
 * asked and what it may read; what this decides is where the answers come from.
 *
 * ## The containment, and what it rests on
 *
 * The assistant has no worktree, no hook and no gates
 * ([0033](../../../doc/decisions/0033-the-third-kind-of-agent.md) §1), so it
 * must have no tools either. Three things stand behind that, and none of them
 * is a flag read off `--help`:
 *
 * 1. **The permission mode is `default`, not `bypassPermissions`.** Under `-p`
 *    there is nothing to grant a permission with — `claude-code.ts` records the
 *    measurement: every Write, Edit and most Bash calls come back as *"you
 *    haven't granted it yet"* and there is no prompt to answer. That behaviour
 *    is what makes a run agent useless and is exactly what contains a reader.
 * 2. **The settings file denies every tool**, and it lives outside anything the
 *    assistant can see, for the reason `hook-config.ts` puts the run's settings
 *    outside the worktree.
 * 3. **The working directory is an empty directory Lingtai owns**, holding
 *    nothing, in no repository. The code it reads is served to it from the bare
 *    mirror, where there is no working tree to run anything in.
 *
 * ## No spend limit
 *
 * 0033 §4: a run is unattended and needs a hard bound; a discussion is attended
 * and the person is the loop. `WALL_MS` below is not that bound — it is how
 * long one turn may hang before the person is told it hung, which is a
 * different question and has to be answerable or the meter never updates.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createClaudeCodeRuntime, NO_RUN_LOG, openRunLog } from "@lingtai/agent";
import { runnableEnv } from "@lingtai/agent-env";
import {
  FILE_BYTES,
  holdDiscussion,
  LOG_LINES,
  outstanding,
  readingFor,
  type DiscussionEvidence,
  type ReadableRef,
} from "@lingtai/conductor/discuss";
import { githubClientFor } from "@lingtai/conductor/filter";
import { loadProject } from "@lingtai/conductor/projects";
import { runLogPath } from "@lingtai/conductor/run-log";
import {
  chatStream,
  parseWorkItemStream,
  reduceControl,
  reduceWorkItem,
  CONTROL_STREAM,
  type DiscussionRequest,
  type Envelope,
} from "@lingtai/domain";
import { stateDir } from "@lingtai/env";
import { eventStore } from "@lingtai/event-store";
import { listAt, readAt, refSha } from "@lingtai/repo";

/**
 * How long one turn of a discussion may take before it is called hung.
 *
 * Not a spend limit (see the header). Five minutes is long for a question that
 * reads a handful of files and short enough that a person watching learns
 * something went wrong rather than concluding the feature does not work.
 */
export const WALL_MS = 5 * 60_000;

/**
 * `turns` is on `RunRequest` and the Claude Code adapter does not pass it to
 * the binary — `#89` is the whole story of that flag. It is carried because the
 * type carries it, and it bounds nothing here.
 */
const LIMITS = { turns: 40, wallMs: WALL_MS };

/**
 * Every tool, denied.
 *
 * A list of what is refused rather than an allowlist of what is permitted, and
 * that is the wrong way round on purpose *here*: the third layer is the empty
 * working directory, so a tool this list has fallen behind on has nothing to
 * act upon. Read is denied with the rest — the assistant does not read the
 * filesystem it is standing in, it names a path and Lingtai serves it from the
 * mirror.
 */
const DENIED = [
  "Bash",
  "BashOutput",
  "KillShell",
  "Edit",
  "Write",
  "NotebookEdit",
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Task",
];

/** Where a chat's settings and its empty working directory live. */
export function chatDir(chatId: string, home = stateDir()): string {
  return join(home, "chats", chatId);
}

/**
 * An empty directory and a settings file that denies everything.
 *
 * Recreated per turn rather than reused, so a directory that somehow acquired
 * a file between two questions is not the directory the next turn runs in.
 */
async function prepare(chatId: string, home = stateDir()): Promise<{ cwd: string; settingsPath: string }> {
  const cwd = chatDir(chatId, home);
  await rm(cwd, { recursive: true, force: true });
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  const settingsPath = join(home, "chats", `${chatId}.settings.json`);
  await writeFile(
    settingsPath,
    `${JSON.stringify({ permissions: { defaultMode: "default", deny: DENIED } }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return { cwd, settingsPath };
}

/**
 * One line per event, oldest first — the log as the assistant reads it.
 *
 * Terse on purpose: the whole payload of a 400-event history would be most of
 * the context and the assistant can ask for what it needs. What is never cut is
 * the *type* and the *actor*, because "what happened, in order, with who did
 * it" is the thing the log is for.
 */
export function logLines(events: readonly Envelope[], limit: number): string[] {
  const lines = events.map((e) => {
    const at = e.at.toISOString().slice(0, 19).replace("T", " ");
    const body = JSON.stringify(e.data ?? {});
    return `${e.seq}  ${at}  ${e.streamId}  ${e.type}  ${e.actor}  ${
      body.length > 400 ? `${body.slice(0, 399)}…` : body
    }`;
  });
  if (lines.length <= limit) return lines;
  return [`[${lines.length - limit} earlier events elided]`, ...lines.slice(-limit)];
}

/**
 * The commit an attempt produced, from that attempt's own stream.
 *
 * The log and not the branch ref, which is the whole of the second blind spot:
 * `worktree add -B` leaves `agent/<n>` pointing at the base after an attempt
 * that committed nothing, so the ref existing proves nothing about the attempt.
 * `RunProducedDiff` is the attempt saying it produced something.
 */
export function headOf(run: readonly Envelope[]): string | null {
  let head: string | null = null;
  for (const e of run) {
    const d = (e.data ?? {}) as Record<string, unknown>;
    if (e.type === "RunProducedDiff" || e.type === "RunProposedCompletion") {
      if (typeof d["headSha"] === "string") head = d["headSha"];
    }
  }
  return head;
}

/**
 * Everything the assistant is given, gathered from the log, GitHub and the
 * mirror.
 *
 * GitHub is allowed to fail and its failure is a sentence in the brief rather
 * than an absence — the rule the detail page follows one level up (#76). The
 * mirror is allowed to be missing for the same reason: a project nothing has
 * cloned yet is a fact, and "no file can be read" is the honest brief for it.
 */
export async function gatherEvidence(request: DiscussionRequest): Promise<DiscussionEvidence> {
  const parsed = parseWorkItemStream(request.workItemId);
  const project = parsed?.project ?? "";
  const own = await eventStore.read(request.workItemId);
  const item = reduceWorkItem(own);

  const runIds = [...item.runs];
  const streams = await Promise.all(runIds.map((id) => eventStore.read(id)));

  // 1-based, in claim order — the same numbering the detail page shows, so a
  // question about "attempt 2" means the attempt the page called 2.
  const index = request.attempt === null ? -1 : request.attempt - 1;
  const head = index >= 0 ? headOf(streams[index] ?? []) : null;

  const state = await loadProject(project).catch(() => null);
  const base = state?.base ?? "main";

  let ticket: DiscussionEvidence["ticket"] = null;
  let ticketProblem: string | null = null;
  if (state === null) {
    ticketProblem = `${project} is not a registered project`;
  } else {
    try {
      const client = await githubClientFor(state);
      const live = await client.getIssue(Number(parsed?.issue));
      ticket = { ref: String(live.number), title: live.title, body: live.body };
    } catch (err) {
      ticketProblem = (err as Error).message;
    }
  }

  const baseSha = await refSha({ project, ref: base });
  const refs: ReadableRef[] = [];
  if (baseSha !== null) {
    const listed = await listAt({ project, ref: base });
    refs.push({ ref: base, sha: baseSha, paths: listed.paths, truncated: listed.truncated });
  }
  if (head !== null && (await refSha({ project, ref: head })) !== null) {
    const listed = await listAt({ project, ref: head });
    refs.push({
      ref: `attempt-${request.attempt}`,
      sha: head,
      paths: listed.paths,
      truncated: listed.truncated,
    });
  }

  return {
    workItemId: request.workItemId,
    attempt: request.attempt,
    ticket,
    ticketProblem,
    log: logLines([...own, ...streams.flat()].sort(bySeq), LOG_LINES),
    // The sentence about a branch that is not there, computed here and recorded
    // on `DiscussionAsked` — never left to the assistant to remember.
    reading: readingFor({ attempt: request.attempt, base, baseSha, head }),
    refs,
  };
}

function bySeq(a: Envelope, b: Envelope): number {
  return a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0;
}

/**
 * Answer one question.
 *
 * Never throws: it is called from the daemon's subscription, and an exception
 * escaping there would stop the loop over a question somebody typed.
 */
export async function answerDiscussion(
  request: DiscussionRequest,
  log: (line: string) => void = () => {},
): Promise<void> {
  const project = parseWorkItemStream(request.workItemId)?.project ?? "";
  const evidence = await gatherEvidence(request);
  const { cwd, settingsPath } = await prepare(request.chatId);
  const runtime = createClaudeCodeRuntime({ permissionMode: "default" });
  // Names to shas. The assistant reads `main` and `attempt-2`; the mirror is
  // asked for the commit, so what it was shown cannot drift under it mid-answer.
  const shas = new Map(evidence.refs.map((r) => [r.ref, r.sha]));

  /**
   * The conversation's trace, as it is produced.
   *
   * [0034](../../../doc/decisions/0034-the-run-log.md) opens on *"the agent
   * produces nothing until it exits"*, and it solved that for runs and not for
   * discussions — so the box where **the person is the control loop** (0033 §4)
   * was the one place with no feedback in it, and an assistant thinking for
   * sixty seconds was indistinguishable from one that had died (#132). The
   * mechanism is 0034's, unchanged: one file, named by the conductor, followed
   * from byte zero by whoever is watching.
   *
   * **Named for the chat, and it is one turn long.** The name has to be the
   * chat's, because that is what makes the reaper right about the file: the id
   * is the chat's own stream, `DiscussionAsked` on it carries the work item, and
   * `findOrphanLogs` removes it when that item lands — the same rule and the
   * same code as a run's. But the *file* is one turn's, and the `finally` below
   * is why: what a follower asks for is the answer being produced right now, and
   * `followRunLog` reads from byte zero, so a file that outlived its turn would
   * show the second question the first question's trace and call it live.
   *
   * **Its ending is its deletion, and there is no `RUN_LOG_END`.** That line's
   * words are a run's — *the diff is on the branch* — and this is a
   * conversation. It does not need them: `holdDiscussion` appends
   * `DiscussionAnswered` on every path it has, including the crash and the
   * unreadable reply, so a turn that is over is a turn whose record has landed,
   * and 0034 §4's *landed → delete* is the whole of the rule. A follower sees
   * the file go and reports `removed`, which is an ending (`RunLogEnding`), so
   * the tail stops and the connection with it. What outlives a turn is exactly
   * the log of a daemon that died mid-answer — the one case still owed an
   * explanation, and the case §5's reaper is for. That residue is also the one
   * thing that could still be here when this opens, and `openRunLog` appends on
   * purpose (a run's second attempt adds to the story rather than erasing it) —
   * so it goes first. This turn's trace is this turn's.
   */
  const path = runLogPath(stateDir(), project, request.chatId);
  await rm(path, { force: true }).catch(() => {});
  const trace = await openRunLog({ path }).catch(() => NO_RUN_LOG);

  /** Both places: the daemon's own output, and the file the board follows. */
  const say = (line: string) => {
    log(line);
    trace.note("chat", line);
  };

  try {
    say(`discussion ${request.chatId} on ${request.workItemId}: ${evidence.reading.join(" · ")}`);

    const held = await holdDiscussion(
      {
        store: eventStore,
        log: say,
        serve: async (ref, path) => {
          const sha = shas.get(ref);
          if (sha === undefined) return null;
          return readAt({ project, ref: sha, path, limitBytes: FILE_BYTES });
        },
        ask: async (prompt, round) =>
          runtime.run({
            // Its own id per round, so nothing resumes a session. `sessionIdFor`
            // is a function of the run id, and reusing one would make a second
            // question a continuation of the first one's transcript rather than a
            // fresh read of the brief this file just built.
            runId: `${request.chatId}:${(await eventStore.read(chatStream(request.chatId))).length}:${round}`,
            cwd,
            prompt,
            settingsPath,
            // Nothing but what the runtime needs to authenticate. No token, no
            // project values, no hook wiring — there is no hook.
            env: runnableEnv({}),
            limits: LIMITS,
            // What the assistant says and thinks, as it says it. The adapter
            // writes its own stream here (`traceOf`), which is the whole of
            // what makes the box on the board move.
            log: trace,
          }),
      },
      {
        chatId: request.chatId,
        evidence,
        question: request.question,
        by: request.by,
      },
    );

    say(
      `discussion ${request.chatId}: ${held.answered ? "answered" : "did not answer"}` +
        (held.costUsd === null ? "" : ` · $${held.costUsd.toFixed(2)}`),
    );
  } finally {
    // The turn is over, so the file is: see `trace` above. Its record is on the
    // chat's stream and this was only ever the trace beside it (0034 §8), and
    // leaving it would hand the *next* question this one's output as the answer
    // being written for it.
    await trace.close("delete");
  }
}

/**
 * Every question the log holds that nothing has answered, answered.
 *
 * Called at daemon startup, because a request made while the daemon was down is
 * waiting in the stream rather than lost — the property `pause` and `now`
 * already have and the reason control goes through the log at all (0013).
 *
 * Sequential, not parallel: three unanswered questions are three agents, and
 * starting them together is the one place this could surprise somebody with a
 * bill they did not watch accumulate.
 */
export async function answerOutstanding(log: (line: string) => void = () => {}): Promise<number> {
  const control = reduceControl(await eventStore.read(CONTROL_STREAM));
  const byChat = new Map<string, DiscussionRequest[]>();
  for (const d of control.discussions) {
    byChat.set(d.chatId, [...(byChat.get(d.chatId) ?? []), d]);
  }

  let answered = 0;
  for (const [chatId, asks] of byChat) {
    // Until the chat has caught up, not once: two questions can land in one
    // burst, and answering only the first would leave the second waiting for
    // an event that has already been.
    for (;;) {
      const events = await eventStore.read(chatStream(chatId));
      if (!outstanding(asks.length, events)) break;
      // The oldest unanswered one. Answers land in order, so the nth request is
      // outstanding exactly when there are fewer than n answers.
      const next = asks[events.filter((e) => e.type === "DiscussionAnswered").length];
      if (!next) break;
      await answerDiscussion(next, log).catch((err: unknown) =>
        log(`discussion ${chatId} failed: ${(err as Error).message}`),
      );
      answered += 1;
    }
  }
  return answered;
}

/**
 * One discussion at a time, whatever asks for one.
 *
 * The daemon's subscription hands events over as they arrive, so a burst of two
 * questions would otherwise start two of these concurrently — and both would
 * read the same chat stream, find the same request outstanding, and answer it
 * twice. Two agents for one question is the one way this feature could surprise
 * somebody with a bill, so the answers are serialised rather than raced.
 */
let queue: Promise<unknown> = Promise.resolve();

/**
 * The daemon's handler for one `DiscussionRequested` as it arrives.
 *
 * It reads the *stream* rather than trusting the envelope's payload for
 * outstandingness: two requests can land in one burst, and answering the one in
 * hand while an earlier one is still unanswered would answer them out of order.
 */
export async function onDiscussionRequested(
  event: Envelope,
  log: (line: string) => void = () => {},
): Promise<void> {
  if (event.type !== "DiscussionRequested") return;
  queue = queue.then(() => answerOutstanding(log)).catch((err: unknown) => {
    log(`discussions: ${(err as Error).message}`);
    return 0;
  });
  await queue;
}
