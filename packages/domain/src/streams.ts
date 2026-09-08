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

export const PROJECT_STREAM_PREFIX = "prj-";

/** `prj-{project}` — everything Lingtai was told about a repository. */
export function projectStream(project: string): string {
  return `${PROJECT_STREAM_PREFIX}${project}`;
}

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
 */
export type LabelState = "queued" | "running" | "gates" | "waiting" | "landed";
