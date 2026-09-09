/**
 * The discussion assistant: a third kind of agent, which reads and cannot run.
 *
 * [0033](../../../doc/decisions/0033-the-third-kind-of-agent.md). Lingtai
 * dispatches two shapes today and both are containers — a run agent with a
 * disposable worktree, a filtered environment, a fail-closed hook and five gate
 * points; and a gate agent given a diff and asked for a verdict. There was no
 * shape for *asking a question about what happened*, so when an item blocked
 * the only move was to read the log yourself. Diagnosing `#89` on 2026-09-08
 * took an hour — the events, then `claude-code.ts`, then one test fixture — and
 * the conclusion was four lines long.
 *
 * ## It reads. It does not run.
 *
 * Its inputs are the log, the ticket, and files from the mirror. It has **no
 * command execution**, and that line is where it is because a command is what
 * makes a run a run: the worktree exists so an agent's writes are disposable,
 * the hook so a tool call is refusable, the gates so nothing it produced reaches
 * `main` unchecked. An agent that only reads needs none of those, and one that
 * executes needs all of them.
 *
 * So the containment here is *the absence of a tool*, and it is structural
 * rather than configured. The assistant is given no worktree and no tools; when
 * it wants a file it **names one and Lingtai serves it** from the bare mirror,
 * where there is no working tree to run anything in. `serve` below is that
 * whole capability.
 *
 * ## Two things it must not pretend
 *
 * **It says what it cannot do.** Reading the shipped bundle reaches *"
 * `error_max_turns` is among the result subtypes"* and no further; proving the
 * binary *accepts* the flag needs a command it does not have. `#89` cost two
 * attempts and $13.04 because `--max-turns` is absent from `claude --help` and
 * present in the binary, and because two agents in a row concluded absence from
 * the help text meant absence from the CLI. An assistant that repeats that
 * inference is worse than none, because it launders a guess into an answer. The
 * rule is in the brief and `cannot` is a field on every answer, so it survives
 * being skimmed.
 *
 * **An attempt may have left no branch.** `worktree.ts` resets it with `-B` on
 * every run and an attempt that committed nothing never had one — `#89`'s second
 * attempt is exactly that. The sentence *"attempt 2 left no branch; I am reading
 * main"* is **Lingtai's**, computed in `readingFor` before the assistant is
 * asked anything and recorded on `DiscussionAsked.reading`. It is not left to
 * the model to remember: reproducing that blind spot inside the tool built to
 * explain it would be the worst outcome available here.
 *
 * ## No spend limit; a meter
 *
 * A run is unattended and needs a hard bound; a discussion is attended and the
 * person is the loop (0033 §4). Every ending appends a `DiscussionAnswered`
 * carrying what it cost — failures included — so the number the person is
 * supposed to be limiting is one they can see.
 *
 * The bounds that *are* here bound **context, not spend**: how many files one
 * turn may ask for, and how many times it may ask before it has to answer. A
 * loop that could ask forever is not a person being the limit, it is a person
 * watching. They are constants rather than recipe fields — unlike the prompt
 * budget of [0029](../../../doc/decisions/0029-the-prompt-budget-is-the-recipes.md)
 * — because nothing repository-specific decides them yet, and a knob with no
 * measurement behind it is a knob nobody can set.
 */
import { chatStream, parsePayload, type Envelope, type ToAppend } from "@lingtai/domain";
import type { EventStore } from "@lingtai/event-store";
import { tellGitHub, type IssueChannel } from "./tell.ts";

export type { IssueChannel } from "./tell.ts";

/**
 * What one turn of the assistant comes back with.
 *
 * A caller's own requirement rather than `@lingtai/agent`'s `RunOutcome`, which
 * this is structurally a subset of. Two reasons, and the second is the binding
 * one: what a discussion needs is *one prompt in, one answer out*, and naming
 * that keeps a runtime out of this file — the board imports this module for
 * `concludeDiscussion`, and a type import from `@lingtai/agent` would make it
 * compile `claude-code.ts`, which is exactly what the subpath exports exist to
 * stop it doing.
 */
export interface Answered {
  turns: number;
  durationMs: number;
  costUsd: number | null;
  /** The model's final message, or null when it produced nothing parseable. */
  text: string | null;
  /** Set when the turn did not complete. Never null and silent. */
  failure: { kind: string; detail: string } | null;
}

/** Files one turn may ask for. Enough to follow a call site into its callee. */
export const READS_PER_TURN = 6;

/**
 * How many times one question may ask for files before it has to answer.
 *
 * Not a spend limit — see the header. It is what stops a question that cannot
 * be answered from being asked forever by a machine while the person who asked
 * it watches a spinner. When it runs out the assistant answers with what it
 * has, and says so.
 */
export const MAX_READ_ROUNDS = 4;

/** Bytes of one file served into the prompt. */
export const FILE_BYTES = 24_000;

/** Events of the item's log put in front of the assistant, newest kept. */
export const LOG_LINES = 400;

// -------------------------------------------------------------- evidence ----

/** The ticket, as GitHub has it now. */
export interface DiscussionTicket {
  ref: string;
  title: string;
  body: string;
}

/** A ref the assistant may name a path at, and what is in it. */
export interface ReadableRef {
  /** The name the assistant uses: `main`, or `attempt-2`. */
  ref: string;
  /** What it resolves to in the mirror. The name is for reading; this is the fact. */
  sha: string;
  paths: readonly string[];
  truncated: boolean;
}

/** Everything the assistant is given before it asks for anything. */
export interface DiscussionEvidence {
  workItemId: string;
  /** 1-based, or null when the question is about the item as a whole. */
  attempt: number | null;
  ticket: DiscussionTicket | null;
  /** Why the ticket is absent, when it is. Never merely missing (#76). */
  ticketProblem: string | null;
  /** The log, oldest first, one line per event. */
  log: readonly string[];
  /**
   * What is readable and what is not, in Lingtai's words.
   *
   * Rendered into the brief *and* recorded on `DiscussionAsked`, so an answer
   * that forgets to mention a missing branch cannot make the page forget too.
   */
  reading: readonly string[];
  refs: readonly ReadableRef[];
}

/**
 * The `reading` sentences, from what the mirror actually has.
 *
 * The `-B` blind spot, stated rather than discovered. `head` is the commit the
 * attempt produced — `RunProducedDiff.headSha`, off that attempt's own stream —
 * and it is null when the attempt produced none.
 *
 * The branch ref is deliberately **not** what is asked. `worktree.ts` runs
 * `worktree add --force -B agent/<n> … <baseSha>` on every run, so the mirror's
 * `agent/<n>` exists after an attempt that committed nothing and points at the
 * base: a caller that checked the ref would find one, read `main` under another
 * name, and report neither. That is `#89`'s second attempt exactly, and it is
 * the thing that killed the repair.
 */
export function readingFor(input: {
  attempt: number | null;
  base: string;
  baseSha: string | null;
  /** The commit the attempt produced, or null when it produced none. */
  head: string | null;
}): string[] {
  const lines: string[] = [];
  lines.push(
    input.baseSha === null
      ? `${input.base}: not in Lingtai's mirror — no file can be read`
      : `${input.base}: readable at ${input.baseSha.slice(0, 7)}`,
  );
  if (input.attempt === null) return lines;
  if (input.head !== null) {
    lines.push(`attempt-${input.attempt}: readable at ${input.head.slice(0, 7)}`);
    return lines;
  }
  lines.push(
    `attempt ${input.attempt} left no branch; I am reading ${input.base}. ` +
      "worktree.ts resets the branch with -B on every run, so an attempt that committed nothing " +
      `left agent/<n> pointing at ${input.base} — there is no code of its own to read.`,
  );
  return lines;
}

// ----------------------------------------------------------------- brief ----

const CANNOT = `
## What you cannot do, and must say so about

You have **no command execution**. You cannot run \`claude --help\`, a test, a
build, \`git\`, or anything else. You have exactly the log above, the ticket
above, and files you ask me for. That is the whole of it.

Two inferences are specifically forbidden, because each one has already cost
this project money:

1. **Absence from documentation is not absence from the program.** Reading a
   shipped bundle can show that a string is present. It cannot show that a
   binary accepts a flag, that a flag does what its name suggests, or that a
   version behaves as its changelog says. \`#89\` cost two attempts and $13.04
   because \`--max-turns\` is missing from \`claude --help\` and present in the
   binary, and two agents in a row concluded otherwise from the help text. If
   answering needs a command, **say that it needs a command** and stop.
2. **A file you were not given is a file you have not read.** Do not describe
   what is in a path you did not ask for and receive.

Everything you could not establish goes in \`cannot\`, in your own words, one
entry each. An empty \`cannot\` is a claim that nothing was left open, so make it
only when that is true.`;

const CONTRACT = `
## How to reply

One JSON object and nothing else. Two shapes, and only two.

To ask for files — up to ${READS_PER_TURN}, each \`<ref>:<path>\` using a ref and a path
from the index above:

{"read":["main:packages/agent/src/claude-code.ts"]}

To answer:

{"answer":"the answer, in prose",
 "cannot":["what a command would have been needed for"],
 "proposal":{"kind":"prompt","text":"the sentence to add"}}

\`proposal\` is what you think should be **written down**, or null when nothing
should be. There are exactly two places it can go and you choose which:

- \`"prompt"\` — an instruction for the *next attempt only*. It is appended to
  that run's prompt and then it is gone.
- \`"ticket"\` — an instruction that outlives every attempt. It is appended to
  the GitHub issue body, where everybody can see it and every later attempt
  reads it.

You are proposing, not deciding. A person clicks, or does not.`;

/** One turn of the exchange, as the chat stream holds it. */
export interface ChatTurn {
  question: string;
  by: string;
  answer: string | null;
}

/**
 * The document the assistant is handed.
 *
 * Assembled in one place so that what it was given is a function of what the
 * log and the mirror held, and is reproducible from them — the same property
 * `RunPrompted` buys for a run (#88). Nothing here reaches anything; it takes
 * evidence and returns text.
 */
export function buildBrief(input: {
  evidence: DiscussionEvidence;
  /** Earlier turns of this same conversation, oldest first. */
  history: readonly ChatTurn[];
  question: string;
  /** Files served so far in this question's rounds, `<ref>:<path>` → contents. */
  served: readonly { at: string; text: string | null }[];
  /** Rounds of reading left. Zero means answer now. */
  roundsLeft: number;
}): string {
  const { evidence } = input;
  const index = evidence.refs
    .map(
      (r) =>
        `### ${r.ref}\n\n${r.paths.join("\n")}${r.truncated ? "\n[index truncated]" : ""}`,
    )
    .join("\n\n");

  const ticket =
    evidence.ticket === null
      ? `The ticket could not be read: ${evidence.ticketProblem ?? "no reason recorded"}.`
      : `#${evidence.ticket.ref} — ${evidence.ticket.title}\n\n${evidence.ticket.body}`;

  const conversation =
    input.history.length === 0
      ? ""
      : `## Earlier in this conversation\n\n${input.history
          .map((t) => `**${t.by} asked:** ${t.question}\n\n**You answered:** ${t.answer ?? "(no answer was recorded)"}`)
          .join("\n\n")}\n`;

  const files =
    input.served.length === 0
      ? ""
      : `## Files you asked for\n\n${input.served
          .map((f) =>
            f.text === null
              ? `### ${f.at}\n\nThere is no such path at that ref.`
              : `### ${f.at}\n\n\`\`\`\n${f.text}\n\`\`\``,
          )
          .join("\n\n")}\n`;

  const budget =
    input.roundsLeft > 0
      ? `You may ask for files ${input.roundsLeft} more time(s) before you have to answer.`
      : "You have no reading left. Answer with what you have, and say in `cannot` what you would have read next.";

  return `You are explaining one work item to the person who owns it. You did not
work on it. You are not going to work on it — you cannot run anything, and
nothing you say is applied to a repository by you.

Your conclusion is one of two things a person could already have written: a
sentence for the next attempt's prompt, or a sentence for the GitHub ticket.
Nothing else. Be short; the answer to "why is this stuck" is usually four lines.

## The work item

${evidence.workItemId}${evidence.attempt === null ? "" : ` · the question is about attempt ${evidence.attempt}`}

## The ticket

${ticket}

## The log, in order

${evidence.log.join("\n")}

## What is readable

${evidence.reading.join("\n")}

## The file index
${index === "" ? "\nNothing is readable, so no path can be asked for." : `\n${index}`}
${conversation}${files}${CANNOT}
${CONTRACT}

${budget}

## The question

${input.question}
`;
}

// ----------------------------------------------------------------- reply ----

export type Reply =
  | { kind: "read"; paths: string[] }
  | {
      kind: "answer";
      text: string;
      cannot: string[];
      proposal: { kind: "prompt" | "ticket"; text: string } | null;
    }
  /** The assistant's answer could not be read as either shape. */
  | { kind: "unreadable"; text: string };

/**
 * The reply, from whatever the assistant actually said.
 *
 * Defensive in the way `parseFindings` and `parseResult` are, and for the same
 * reason: a model asked for JSON usually gives JSON, and the turn where it does
 * not must not become a crash with no record of the money it cost.
 *
 * An unreadable reply is **not** repaired into an answer. The prose is kept and
 * shown as it stands, marked as unreadable, because the alternative — treating
 * the raw text as the answer — is how a refusal or a half-finished thought gets
 * presented as a conclusion.
 */
export function parseReply(text: string | null): Reply {
  if (text === null || text.trim() === "") return { kind: "unreadable", text: "" };

  for (const candidate of jsonCandidates(text)) {
    let value: unknown;
    try {
      value = JSON.parse(candidate.trim());
    } catch {
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    const v = value as Record<string, unknown>;

    if (Array.isArray(v["read"])) {
      const paths = v["read"]
        .map((p) => String(p))
        .filter((p) => p.includes(":"))
        .slice(0, READS_PER_TURN);
      // An empty or unusable `read` is not a request for nothing — it is a turn
      // that said neither shape, and answering it as "read no files" would spend
      // another turn to arrive back here.
      if (paths.length > 0) return { kind: "read", paths };
      continue;
    }

    if (typeof v["answer"] === "string") {
      const proposal = v["proposal"];
      return {
        kind: "answer",
        text: v["answer"],
        cannot: Array.isArray(v["cannot"]) ? v["cannot"].map((c) => String(c)) : [],
        proposal:
          proposal !== null && typeof proposal === "object" && proposal !== undefined
            ? proposalOf(proposal as Record<string, unknown>)
            : null,
      };
    }
  }

  return { kind: "unreadable", text };
}

function proposalOf(p: Record<string, unknown>): { kind: "prompt" | "ticket"; text: string } | null {
  const text = typeof p["text"] === "string" ? p["text"] : "";
  if (text.trim() === "") return null;
  // Anything that is not the two carriers is dropped rather than guessed at.
  // 0033 §2: a discussion introduces no third place to put an instruction.
  return p["kind"] === "prompt" || p["kind"] === "ticket" ? { kind: p["kind"], text } : null;
}

function jsonCandidates(text: string): string[] {
  const out: string[] = [];
  for (const block of text.match(/```(?:json)?\s*([\s\S]*?)```/g) ?? []) {
    out.push(block.replace(/```(?:json)?/g, "").replace(/```/g, ""));
  }
  const brace = text.indexOf("{");
  if (brace >= 0) out.push(text.slice(brace));
  out.push(text);
  return out;
}

// ------------------------------------------------------------------ hold ----

export interface DiscussionPorts {
  /** One file from the mirror, or null when there is no such path at that ref. */
  serve(ref: string, path: string): Promise<string | null>;
  /**
   * Runs the assistant once.
   *
   * A port rather than a `Runtime`, because what this needs is *one prompt in,
   * one answer out* — no worktree, no settings, no environment. The host
   * decides which runtime answers and what it is allowed to do; this decides
   * what it is asked.
   */
  ask(prompt: string, round: number): Promise<Answered>;
  store: EventStore;
  log?: (line: string) => void;
}

export interface HoldOptions {
  chatId: string;
  evidence: DiscussionEvidence;
  question: string;
  by: string;
}

/** What one question cost and what it concluded. */
export interface HeldTurn {
  costUsd: number | null;
  answered: boolean;
  proposal: { kind: "prompt" | "ticket"; text: string } | null;
}

/**
 * One question, answered, with both events on `chat-<id>`.
 *
 * The ask is appended **before** the assistant is run, and it carries
 * `reading`. So a discussion that crashes, times out or is killed still leaves
 * the record of what was asked and of what could not be read — which is the
 * half of `#89` that no amount of answering would have fixed.
 *
 * It never throws. A discussion is a thing a person is watching; an exception
 * that reached the daemon's subscription would stop the loop over a question.
 */
export async function holdDiscussion(
  ports: DiscussionPorts,
  options: HoldOptions,
): Promise<HeldTurn> {
  const log = ports.log ?? (() => {});
  const stream = chatStream(options.chatId);
  const before = await ports.store.read(stream);

  // `by` is already an actor — `human:steven`, the same string the board's card
  // actions record. Prefixing it here would make it `human:human:steven` and
  // fail the envelope's own regex, which is the check that catches it.
  await append(ports.store, stream, before.length, options.by, "DiscussionAsked", {
    workItemId: options.evidence.workItemId,
    attempt: options.evidence.attempt,
    by: options.by,
    question: options.question,
    reading: [...options.evidence.reading],
  });

  const history = turnsOf(before);
  const served: { at: string; text: string | null }[] = [];
  let turns = 0;
  let durationMs = 0;
  let cost: number | null = null;

  const spend = (outcome: Answered) => {
    turns += outcome.turns;
    durationMs += outcome.durationMs;
    if (outcome.costUsd !== null) cost = (cost ?? 0) + outcome.costUsd;
  };

  const answer = (data: {
    text: string;
    cannot: string[];
    proposal: { kind: "prompt" | "ticket"; text: string } | null;
    failure: string | null;
  }) =>
    append(ports.store, stream, -1, `agent:${options.chatId}`, "DiscussionAnswered", {
      text: data.text,
      read: served.map((s) => s.at),
      cannot: data.cannot,
      proposal: data.proposal,
      turns,
      durationMs,
      costUsd: cost,
      failure: data.failure,
    });

  for (let round = 0; round <= MAX_READ_ROUNDS; round += 1) {
    const prompt = buildBrief({
      evidence: options.evidence,
      history,
      question: options.question,
      served,
      roundsLeft: MAX_READ_ROUNDS - round,
    });

    const outcome = await ports.ask(prompt, round).catch(
      (err: unknown): Answered => ({
        turns: 0,
        durationMs: 0,
        costUsd: null,
        text: null,
        failure: { kind: "crash", detail: (err as Error).message },
      }),
    );
    spend(outcome);

    if (outcome.failure) {
      log(`discussion ${options.chatId}: ${outcome.failure.kind} — ${outcome.failure.detail}`);
      await answer({
        text: "",
        cannot: [],
        proposal: null,
        failure: `${outcome.failure.kind}: ${outcome.failure.detail}`,
      });
      return { costUsd: cost, answered: false, proposal: null };
    }

    const reply = parseReply(outcome.text);

    if (reply.kind === "read" && round < MAX_READ_ROUNDS) {
      for (const at of reply.paths) {
        const cut = at.indexOf(":");
        const ref = at.slice(0, cut);
        const path = at.slice(cut + 1);
        served.push({ at, text: await ports.serve(ref, path).catch(() => null) });
      }
      log(`discussion ${options.chatId}: served ${reply.paths.length} file(s)`);
      continue;
    }

    if (reply.kind === "answer") {
      await answer({ text: reply.text, cannot: reply.cannot, proposal: reply.proposal, failure: null });
      return { costUsd: cost, answered: true, proposal: reply.proposal };
    }

    // Out of rounds while still asking, or an answer nothing could read. Both
    // end the turn, and both say which — an unreadable reply presented as an
    // answer is the thing `parseReply` refuses to do.
    await answer({
      text: reply.kind === "unreadable" ? reply.text : "",
      cannot: [],
      proposal: null,
      failure:
        reply.kind === "unreadable"
          ? "the assistant's reply was not readable as an answer"
          : `the assistant asked for files after ${MAX_READ_ROUNDS} rounds of reading`,
    });
    return { costUsd: cost, answered: false, proposal: null };
  }

  // Unreachable: the loop answers or fails on every path.
  return { costUsd: cost, answered: false, proposal: null };
}

// -------------------------------------------------------------- conclude ----

/**
 * What a whole conversation cost, from its own stream.
 *
 * Null when nothing reported a figure — which is not the same as free, and is
 * why this is nullable rather than zero. `RunFinished.costUsd` is nullable for
 * the same reason and the board reads it the same way.
 */
export function spendOf(events: readonly Envelope[]): number | null {
  let total: number | null = null;
  for (const e of events) {
    if (e.type !== "DiscussionAnswered") continue;
    const cost = (e.data as { costUsd?: unknown } | null)?.costUsd;
    if (typeof cost === "number") total = (total ?? 0) + cost;
  }
  return total;
}

/**
 * The heading a discussion's addition to a ticket sits under.
 *
 * Named rather than anonymous so a second addition is legible as a second
 * addition, and so a person reading the issue can see which sentences came out
 * of Lingtai rather than out of whoever filed it.
 */
export function appendToBody(body: string, text: string, by: string, at: Date): string {
  const stamp = at.toISOString().slice(0, 10);
  const block = `## Added from a discussion, ${stamp}, by ${by}\n\n${text.trim()}\n`;
  return body.trim() === "" ? block : `${body.trimEnd()}\n\n${block}`;
}

export interface ConcludeOptions {
  store: EventStore;
  workItemId: string;
  chatId: string;
  by: string;
  outcome: "prompt" | "ticket" | "none";
  /** The artefact, for the two outcomes that have one. */
  text?: string;
  /** GitHub and the issue's body as it stands, for `ticket`. */
  ticket?: { github: IssueChannel; body: string };
  now?: Date;
}

/**
 * Ending a discussion: the artefact, then the one line on the work item.
 *
 * **Two outputs and only two** (0033 §2). `prompt` appends `PromptEdited`,
 * which the next claim consumes and then discards; `ticket` edits the issue
 * body, where it versions as `ticket@NNNN` and every later attempt reads it.
 * There is no third carrier, and `none` — a question answered that needed
 * nothing written down — is the commonest ending of all.
 *
 * `DiscussionHeld` is appended **last and always**, including when the artefact
 * did not land. It is the money's only record on the work item, and a spend
 * that vanished because a GitHub write failed would be exactly the meter 0033
 * §4 says a person is supposed to be able to see.
 */
export async function concludeDiscussion(
  options: ConcludeOptions,
): Promise<{ ok: boolean; detail: string }> {
  const { store, workItemId, chatId, by } = options;
  const text = (options.text ?? "").trim();

  let detail = "the discussion is closed";
  let ok = true;

  if (options.outcome === "prompt") {
    if (text === "") return { ok: false, detail: "there is nothing to add to the next run's prompt" };
    const at = (await store.read(workItemId)).length;
    await store.append(workItemId, at, [
      {
        type: "PromptEdited",
        actor: by,
        data: parsePayload("PromptEdited", { text, by, chatId }),
      },
    ]);
    detail = "the next attempt's prompt carries it";
  }

  if (options.outcome === "ticket") {
    if (text === "") return { ok: false, detail: "there is nothing to add to the ticket" };
    if (!options.ticket) return { ok: false, detail: "the ticket could not be read, so it cannot be edited" };
    const body = appendToBody(options.ticket.body, text, by, options.now ?? new Date());
    // Through `tellGitHub`, so the write is recorded the way every other write
    // to an issue is — `IssueUpdated` or `IssueUpdateFailed`, and never a throw.
    await tellGitHub({
      store,
      github: options.ticket.github,
      workItemId,
      change: { kind: "body", body },
    });
    const said = await store.read(workItemId);
    const last = said[said.length - 1];
    ok = last?.type === "IssueUpdated";
    detail = ok ? "the ticket carries it" : "GitHub refused the edit; the log says why";
  }

  const spend = spendOf(await store.read(chatStream(chatId)));
  const at = (await store.read(workItemId)).length;
  await store.append(workItemId, at, [
    {
      type: "DiscussionHeld",
      actor: by,
      data: parsePayload("DiscussionHeld", {
        chatId,
        costUsd: spend,
        outcome: options.outcome,
        by,
      }),
    },
  ]);

  return { ok, detail };
}

/**
 * The conversation so far, from the stream.
 *
 * Pairs an ask with the answer that followed it. An ask with nothing after it
 * is a question the daemon never got to — kept, so the assistant sees that it
 * was asked and the page can say the same.
 */
export function turnsOf(events: readonly Envelope[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const e of events) {
    const d = (e.data ?? {}) as Record<string, unknown>;
    if (e.type === "DiscussionAsked") {
      turns.push({ question: String(d["question"] ?? ""), by: String(d["by"] ?? ""), answer: null });
      continue;
    }
    if (e.type !== "DiscussionAnswered") continue;
    const last = turns[turns.length - 1];
    if (last && last.answer === null) last.answer = String(d["text"] ?? "");
  }
  return turns;
}

/**
 * Whether a request has been answered yet.
 *
 * The whole of the request's state machine, and it is arithmetic rather than a
 * `consumed` event — the same rule `RunRequested` follows, where a request is
 * satisfied by the item ceasing to be queued. Asks and answers are counted
 * because a conversation is several requests against one stream, and the nth
 * request is outstanding exactly when fewer than n answers exist.
 */
export function outstanding(asked: number, events: readonly Envelope[]): boolean {
  const answered = events.filter((e) => e.type === "DiscussionAnswered").length;
  return answered < asked;
}

/**
 * Appends one event, re-reading the stream's length when `at` is `-1`.
 *
 * The re-read is not a nicety: the ask was appended at the top of
 * `holdDiscussion` and minutes of agent time have passed since, during which a
 * follow-up question can have landed on the same stream. Reading the length
 * again is what an `expectedVersion` is for.
 */
async function append(
  store: EventStore,
  stream: string,
  at: number,
  actor: string,
  type: "DiscussionAsked" | "DiscussionAnswered",
  data: unknown,
): Promise<void> {
  const version = at >= 0 ? at : (await store.read(stream)).length;
  const event: ToAppend = { type, actor, data: parsePayload(type, data) };
  await store.append(stream, version, [event]);
}
