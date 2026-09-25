/**
 * **`end`'s third effect, carried out** (`#240`) — the half `end-point.ts` does
 * not do.
 *
 * Resolving is a decision and doing is I/O, and they are two steps on purpose;
 * these are the properties of the second one, against a `RefChannel` that
 * records what it was asked and a store that only has to hold events. No
 * network, no Postgres, no `git`.
 *
 * The three worth holding:
 *
 * - **It deletes the arms and, by default, nothing else.** `agent/<n>` stays:
 *   after a merge its commits are reachable from `main`, but it is the ref a
 *   person follows from the merge commit.
 * - **It cannot take a neighbour's refs with it.** GitHub's matching-refs is a
 *   plain string prefix, so asking under `heads/agent/24` answers
 *   `heads/agent/240-attempt-1` as well. A sweep that trusted the answer would
 *   delete a three-digit ticket's work while cleaning up after a two-digit one.
 * - **It never throws, and a ref that is already gone is not an error.** `end`
 *   cannot refuse, so a delete GitHub declined is a row on the log and a run
 *   that still landed.
 */
import { describe, expect, it } from "vitest";
import { createMemoryEventStore } from "@lingtai/event-store/memory";
import type { EventStore } from "@lingtai/event-store";
import type { PayloadOf } from "@lingtai/domain";
import { agentBranch, armBranch } from "../src/branches.ts";
import { type RefChannel, sweepRefs } from "../src/tell.ts";

/** A remote's ref list, and what a sweep did to it. */
function fakeRefs(refs: readonly string[], opts: { fail?: boolean } = {}) {
  const held = new Set(refs);
  const asked: string[] = [];
  const channel: RefChannel = {
    async matchingRefs(prefix) {
      asked.push(prefix);
      if (opts.fail) throw new Error("403 resource not accessible by integration");
      return [...held].filter((ref) => ref.startsWith(prefix));
    },
    async deleteRef(ref) {
      if (!held.delete(ref)) throw new Error(`422 reference does not exist: ${ref}`);
    },
  };
  return { channel, asked, left: () => [...held].sort() };
}

/** The rows this appended, newest last. */
async function rows(store: EventStore, workItemId: string) {
  return (await store.read(workItemId))
    .filter((e) => e.type === "IssueUpdated" || e.type === "IssueUpdateFailed")
    .map((e) => ({ type: e.type, ...(e.data as PayloadOf<"IssueUpdated">) }));
}

const BRANCH = agentBranch(240);
const HEADS = (name: string) => `heads/${name}`;

/** What a ticket that ran four approaches and landed leaves on `origin`. */
const AFTER_FOUR_ATTEMPTS = [
  HEADS(BRANCH),
  HEADS(armBranch(BRANCH, 1)),
  HEADS(armBranch(BRANCH, 2)),
  HEADS(armBranch(BRANCH, 3)),
  HEADS(armBranch(BRANCH, 4)),
];

describe("sweeping a landed ticket's history refs", () => {
  it("deletes every arm and keeps the branch", async () => {
    const store = createMemoryEventStore();
    const remote = fakeRefs(AFTER_FOUR_ATTEMPTS);

    await sweepRefs({ store, github: remote.channel, workItemId: "wi-lingtai-240", andTheBranch: false });

    expect(remote.left()).toEqual([HEADS(BRANCH)]);
    expect(await rows(store, "wi-lingtai-240")).toEqual([
      {
        type: "IssueUpdated",
        project: "lingtai",
        issue: "240",
        change: "refs",
        detail: [1, 2, 3, 4].map((n) => HEADS(armBranch(BRANCH, n))).join(","),
      },
    ]);
  });

  it("takes the branch too when the recipe asked for it", async () => {
    const store = createMemoryEventStore();
    const remote = fakeRefs(AFTER_FOUR_ATTEMPTS);

    await sweepRefs({ store, github: remote.channel, workItemId: "wi-lingtai-240", andTheBranch: true });

    expect(remote.left()).toEqual([]);
  });

  /**
   * **The prefix is not a path**, and this is the case that says so. `#24` and
   * `#240` share one, and a sweep after `#24` landed must leave `#240`'s four
   * approaches exactly where they are.
   */
  it("leaves a longer ticket number's refs alone", async () => {
    const store = createMemoryEventStore();
    const twoDigit = agentBranch(24);
    const remote = fakeRefs([
      ...AFTER_FOUR_ATTEMPTS,
      HEADS(twoDigit),
      HEADS(armBranch(twoDigit, 1)),
    ]);

    await sweepRefs({ store, github: remote.channel, workItemId: "wi-lingtai-24", andTheBranch: true });

    expect(remote.left()).toEqual([...AFTER_FOUR_ATTEMPTS].sort());
  });

  /**
   * An item whose only claim landed on its first attempt has one arm and one
   * branch; an item that landed before `#239` published any has none. Neither
   * is an error, and the row says which it was — *none* is a fact, and a
   * missing row would read as a sweep that never ran.
   */
  it("records that there was nothing to delete, rather than failing", async () => {
    const store = createMemoryEventStore();
    const remote = fakeRefs([HEADS(BRANCH)]);

    await sweepRefs({ store, github: remote.channel, workItemId: "wi-lingtai-240", andTheBranch: false });

    expect(remote.left()).toEqual([HEADS(BRANCH)]);
    expect((await rows(store, "wi-lingtai-240"))[0]).toMatchObject({
      type: "IssueUpdated",
      detail: "none",
    });
  });

  /**
   * `end` cannot refuse, so this cannot either. The record is what 0022 kept
   * the pair for: afterwards nobody can tell *we never swept* from *we swept
   * and GitHub said no*.
   */
  it("records a refusal and returns normally", async () => {
    const store = createMemoryEventStore();
    const remote = fakeRefs(AFTER_FOUR_ATTEMPTS, { fail: true });

    await expect(
      sweepRefs({ store, github: remote.channel, workItemId: "wi-lingtai-240", andTheBranch: false }),
    ).resolves.toBeUndefined();

    expect(remote.left()).toEqual([...AFTER_FOUR_ATTEMPTS].sort());
    expect((await rows(store, "wi-lingtai-240"))[0]).toMatchObject({
      type: "IssueUpdateFailed",
      change: "refs",
      error: "403 resource not accessible by integration",
    });
  });

  /**
   * It asks under the branch and filters, rather than asking under the arm
   * prefix — one request either way, and this one also sees `agent/<n>` itself,
   * which `andTheBranch` needs.
   */
  it("asks GitHub once, under the branch", async () => {
    const store = createMemoryEventStore();
    const remote = fakeRefs(AFTER_FOUR_ATTEMPTS);

    await sweepRefs({ store, github: remote.channel, workItemId: "wi-lingtai-240", andTheBranch: false });

    expect(remote.asked).toEqual([HEADS(BRANCH)]);
  });
});
