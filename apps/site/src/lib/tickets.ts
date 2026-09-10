/**
 * The two tickets under "when it goes wrong", and where each figure came from.
 *
 * The board in the hero is a photograph of the log and cannot be written by
 * hand ([`snapshot.ts`](../../scripts/snapshot.ts)). These two are the
 * opposite case: they are *history* — a ticket that stopped and a ticket that
 * landed, each with what it cost — and history does not go stale, so it is
 * allowed to be prose. What it is not allowed to be is unsourced.
 *
 * So a case carries its `source`: the file in `doc/` that records the figure.
 * `test/tickets.test.ts` opens each one and fails if the document does not
 * contain both the reference and the amount. A number that somebody rounded up
 * on the way to the page therefore breaks the build rather than sitting there
 * reading as true, which is the whole reason this page is allowed to print a
 * figure at all.
 *
 * Both are issues in this repository, so both are public and a reader can go
 * and check.
 */

/** Where a reference on this site goes. Lingtai's own issues, and no others. */
export const ISSUES = "https://github.com/steven-zhc/lingtai/issues/";

export interface Ticket {
  /** The issue number in this repository. */
  ref: number;
  /** Its kind label, which is what makes it visible to the queue at all. */
  kind: string;
  /** Whether it reached `main`. Half the point is that one of them did not. */
  landed: boolean;
  /** What the whole ticket cost, across every attempt it took. */
  costUsd: number;
  /** How many times an agent was given it, when the record says. */
  attempts: number | null;
  /** What the ticket asked for. */
  what: string;
  /** What happened to it, and what that cost a person as well as a card. */
  story: string;
  /** The file under `doc/` that records the figure, checked by the test. */
  source: string;
}

export const TICKETS: Ticket[] = [
  {
    ref: 89,
    kind: "bug",
    landed: false,
    costUsd: 13.04,
    attempts: 2,
    what: "A bug, given to an agent twice, and it never merged.",
    story:
      "Both attempts concluded that the runtime had no --max-turns flag, because it is absent from the binary's own --help — and it is present in the binary. Two agents in a row turned a missing line of documentation into a fact. It ended in “waiting on you”, and working out why took a person an hour: the events, then one source file, then one test fixture.",
    source: "decisions/0033-the-third-kind-of-agent.md",
  },
  {
    ref: 84,
    kind: "feature",
    landed: true,
    costUsd: 26.53,
    attempts: null,
    what: "The repair agent — a failed run buys one attempt to fix itself.",
    story:
      "It landed, and the moment it did, the log of what the agent was thinking was deleted. That is the rule and not an accident: those files exist to explain why something is not done, so a run that landed has nothing left to explain. What survives is the diff and the events.",
    source: "decisions/0034-the-run-log.md",
  },
];
