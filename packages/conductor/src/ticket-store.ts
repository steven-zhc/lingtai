/**
 * `TicketStore` — where tickets come from, and the one door a new one goes in by
 * ([0036](../../../doc/decisions/0036-the-core-takes-a-ticket.md) §2).
 *
 * **`propose` is the only verb here yet.** 0036 names `list`, `get` and `save`
 * as the port's shape, and their extraction out of `@lingtai/github` has not
 * happened: discovery, the prompt and `end` still hold the client directly.
 * This file does not do that extraction under another ticket's name. It puts
 * the third verb where the other three will go, so that the backlog's accept
 * calls *the thing that owns tickets* rather than a GitHub call of its own
 * (`#137`).
 *
 * > **Lingtai proposes; a person decides it exists.**
 *
 * The store is how it comes to exist, and it obeys 0036 §4 from this end too:
 * **the store translates and does not judge.** What the ticket says — its
 * title, body, kind and any hold — is decided before it arrives here, by the
 * person and the recipe. The adapter decides only how to write that down: on
 * GitHub, the kind is a label, so is a hold, and the key is a comment in the
 * body.
 */
import type { GitHubClient, Issue } from "@lingtai/github";

export interface ProposedTicket {
  /**
   * The identity `propose` is idempotent on: the finding's key. A store that is
   * asked twice for the same key answers with the ticket it already has.
   */
  key: string;
  /** No ticket for this key can be older than this — when a person accepted it. */
  since: Date;
  title: string;
  /** The body a later run is prompted with, if it runs. */
  body: string;
  /** The recipe's word for what this is — one of `source.kinds`. */
  kind: string;
  /** Anything else the ticket should carry, verbatim — `agent:hold`, usually. */
  labels: readonly string[];
}

export interface ProposedRef {
  /** The store's own identity for the ticket: `"212"` on GitHub. */
  externalRef: string;
  url: string | null;
  /** This call wrote the ticket, rather than finding one an earlier call wrote. */
  created: boolean;
}

export interface TicketStore {
  readonly source: string;
  /**
   * The ticket for `ticket.key`: the one that exists, or a new one.
   *
   * **Safe to repeat, and to race.** Two calls with one key converge on one
   * ticket: each looks before it writes, and a call that wrote and then finds
   * an older ticket for the key withdraws its own. Anything thrown says nothing
   * about whether a write landed — which is why repeating is how a failure is
   * answered.
   */
  propose(ticket: ProposedTicket): Promise<ProposedRef>;
  /**
   * Withdraw a ticket this store opened and the log did not record, naming the
   * one that is. Only ever called by the call that `created` it.
   */
  withdraw(externalRef: string, keptRef: string, why: string): Promise<void>;
}

/** How a GitHub issue says which finding it is. Invisible when rendered. */
export function keyMarker(key: string): string {
  return `<!-- lingtai:finding ${key} -->`;
}

/**
 * Clocks disagree, and GitHub's `since` is its own `updated_at`. An hour is
 * far wider than any skew and still keeps the listing to recent issues.
 */
const SKEW_MS = 60 * 60_000;

/** GitHub issues. `client` is the one the caller already has for the project. */
export function githubTicketStore(
  client: Pick<GitHubClient, "createIssue" | "listIssuesSince" | "comment" | "closeIssue">,
): TicketStore {
  const ref = (issue: Issue, created: boolean): ProposedRef => ({
    externalRef: String(issue.number),
    url: issue.url,
    created,
  });

  /** The issue a key belongs to: the oldest one carrying it. */
  async function carrying(key: string, since: Date): Promise<Issue | undefined> {
    const marker = keyMarker(key);
    const found = (await client.listIssuesSince(new Date(since.getTime() - SKEW_MS)))
      .filter((i) => i.body.includes(marker))
      .sort((a, b) => a.number - b.number);
    return found[0];
  }

  async function withdraw(externalRef: string, keptRef: string, why: string): Promise<void> {
    const n = Number(externalRef);
    await client.comment(n, `Duplicate of #${keptRef} — ${why}.`);
    await client.closeIssue(n, "not_planned");
  }

  return {
    source: "github-issue",
    withdraw,

    async propose(ticket) {
      const existing = await carrying(ticket.key, ticket.since);
      if (existing) return ref(existing, false);

      const labels = [...new Set([ticket.kind, ...ticket.labels].filter((l) => l.trim() !== ""))];
      const body = `${ticket.body.trimEnd()}\n\n${keyMarker(ticket.key)}\n`;
      const opened = await client.createIssue({ title: ticket.title, body, labels });

      // Look again. A call that raced this one may have opened its own in the
      // meantime; the older issue is the key's, so the newer withdraws.
      const first = await carrying(ticket.key, ticket.since);
      if (first && first.number < opened.number) {
        await withdraw(
          String(opened.number),
          String(first.number),
          "two accepts of the same finding opened an issue at once, and the older one is kept",
        );
        return ref(first, false);
      }
      return ref(opened, true);
    },
  };
}
