/**
 * How a stream is named, and the five states a card can be in.
 *
 * Vocabulary, in the package that holds vocabulary. Both of these were in
 * `conductor` and both are needed by things that must not depend on it: the
 * projector folds `wi-…` streams into cards, and the board renders the states.
 * A shared word does not belong to whoever happened to say it first.
 *
 * Neither of these decides anything, which is why they can live here: `domain`
 * imports nothing, so everything can import `domain`.
 */

/** `wi-{project}-{n}`, the work item's own stream. */
export function workItemStream(project: string, externalRef: string | number): string {
  return `wi-${project}-${externalRef}`;
}

/**
 * The inverse, beside its constructor so the two cannot drift.
 *
 * Null when the id is not one of ours. A project name may contain `-`, so the
 * split is on the *last* one — which is also why this is a function and not a
 * regex written out at each call site. It was three copies before `#69` needed
 * a fourth.
 */
export function parseWorkItemStream(id: string): { project: string; issue: string } | null {
  const body = id.startsWith("wi-") ? id.slice(3) : id;
  const cut = body.lastIndexOf("-");
  if (cut < 0) return null;
  const project = body.slice(0, cut);
  const issue = body.slice(cut + 1);
  if (!project || !issue) return null;
  return { project, issue };
}

/**
 * The project a stream belongs to, or null when it belongs to none.
 *
 * Strict where `parseWorkItemStream` is lenient, and the difference is the
 * reason this exists: that one also takes a bare `project-issue` body, so
 * `ctl-conductor` parses out of it as the project `ctl` — which is a repository
 * nobody has. Everything on the control stream, and the chat and extension
 * streams with it, belongs to no repository, and the callers that route by
 * project need that answered as *none* rather than as a plausible-looking name.
 */
export function streamProject(id: string): string | null {
  if (!id.startsWith("wi-")) return null;
  return parseWorkItemStream(id)?.project ?? null;
}

export const CHAT_STREAM_PREFIX = "chat-";

/**
 * `chat-{id}` — one discussion about one work item, whole.
 *
 * Its own stream rather than the work item's, because
 * [0033](../../../doc/decisions/0033-the-third-kind-of-agent.md) §6 says a
 * forty-turn exploration appended to the work item would drown the history the
 * detail page exists to show — permanently, the log being append-only. The work
 * item gets one `DiscussionHeld` pointing here.
 *
 * The id is passed in rather than made here: whoever opens the conversation
 * names it, and a follow-up question is another request carrying the same name.
 */
export function chatStream(id: string): string {
  return id.startsWith(CHAT_STREAM_PREFIX) ? id : `${CHAT_STREAM_PREFIX}${id}`;
}

export const PROJECT_STREAM_PREFIX = "prj-";

/** `prj-{project}` — everything Lingtai was told about a repository. */
export function projectStream(project: string): string {
  return `${PROJECT_STREAM_PREFIX}${project}`;
}

/**
 * `ext-subscribers` — every event subscriber that failed, for the installation.
 *
 * One stream rather than one per project, for the reason `ctl-conductor` is
 * one: a subscriber belongs to the daemon and not to a repository, and half of
 * what it is handed — pauses, shutdowns, questions — names no project at all.
 *
 * Not the failing event's own stream, which is the tempting place and the wrong
 * one. The daemon is following the log while a run appends to that stream, so a
 * write back to it would race the run and turn a notifier's bad day into a
 * `ConcurrencyError` in the middle of one.
 */
export const SUBSCRIBER_STREAM = "ext-subscribers";

/** `int-{project}-{base}` — one lane per base branch, forever. */
export function integrationStream(project: string, base: string): string {
  return `int-${project}-${base.replace(/\//g, ".")}`;
}

/**
 * Where a task is, as the board and the labels both say it.
 *
 * A union rather than `string`, since `#71`. Every unlisted state means "no
 * labels", so with a `string` a typo and a deliberate clear were the same
 * expression — and the one state nobody ever passed (`waiting`) went unnoticed
 * for the whole life of the outbox.
 *
 * The list is the value and the type is read off it, so that the states can be
 * enumerated at runtime. That is what lets the board *prove* every one of them
 * lands on a column (#59) instead of asserting it about the five a test
 * happened to think of.
 */
export const LABEL_STATES = ["queued", "running", "gates", "waiting", "landed"] as const;

export type LabelState = (typeof LABEL_STATES)[number];
