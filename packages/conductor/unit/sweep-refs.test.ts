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
 * - **A sweep that stopped half way says which arms went.** The deletes are one
 *   call each, so a refusal on the third leaves two gone for good — and the
 *   names are the one fact the remote can no longer be asked for.
 */
import { describe, expect, it } from "vitest";
import { createMemoryEventStore } from "@lingtai/event-store/memory";
import type { EventStore } from "@lingtai/event-store";
import type { PayloadOf, ToAppend } from "@lingtai/domain";
import { agentBranch, armBranch } from "../src/branches.ts";
import { type IssueChannel, type RefChannel, sweepRefs, tellGitHubAbout } from "../src/tell.ts";

/** A remote's ref list, and what a sweep did to it. */
function fakeRefs(
  refs: readonly string[],
  opts: { fail?: boolean; refuseFrom?: string } = {},
) {
  const held = new Set(refs);
  const asked: string[] = [];
  const channel: RefChannel = {
    async matchingRefs(prefix) {
      asked.push(prefix);
      if (opts.fail) throw new Error("403 resource not accessible by integration");
      return [...held].filter((ref) => ref.startsWith(prefix));
    },
    async deleteRef(ref) {
      // A delete GitHub declines from some ref onwards — branch protection, or
      // a secondary rate limit reached part-way down the list.
      if (opts.refuseFrom !== undefined && ref >= opts.refuseFrom) {
        throw new Error("403 secondary rate limit");
      }
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

  /**
   * **The row has to name the arms that already went** — the case a `doomed`
   * written down before the loop got wrong.
   *
   * Four arms, and the third delete is refused. Two are gone from `origin` for
   * good and the remote cannot be asked which two, so if the failure row says
   * only *403* then afterwards *we swept nothing* and *we swept half of it* are
   * one row — which is exactly the pair 0022 kept `IssueUpdated` and
   * `IssueUpdateFailed` apart for.
   */
  it("names the arms it had already deleted when a delete was refused", async () => {
    const store = createMemoryEventStore();
    const remote = fakeRefs(AFTER_FOUR_ATTEMPTS, { refuseFrom: HEADS(armBranch(BRANCH, 3)) });

    await sweepRefs({ store, github: remote.channel, workItemId: "wi-lingtai-240", andTheBranch: false });

    expect(remote.left()).toEqual(
      [HEADS(BRANCH), HEADS(armBranch(BRANCH, 3)), HEADS(armBranch(BRANCH, 4))].sort(),
    );
    const row = (await rows(store, "wi-lingtai-240"))[0]!;
    expect(row.type).toBe("IssueUpdateFailed");
    expect((row as unknown as { error: string }).error).toBe(
      `403 secondary rate limit — after deleting ${HEADS(armBranch(BRANCH, 1))},${HEADS(armBranch(BRANCH, 2))}`,
    );
  });

  /**
   * And a sweep that was refused before it deleted anything says only the
   * error: a list nobody can read is worse than no list, and *none went* is
   * what an unadorned message means.
   */
  it("says only the error when nothing had gone yet", async () => {
    const store = createMemoryEventStore();
    const remote = fakeRefs(AFTER_FOUR_ATTEMPTS, { refuseFrom: HEADS(armBranch(BRANCH, 1)) });

    await sweepRefs({ store, github: remote.channel, workItemId: "wi-lingtai-240", andTheBranch: false });

    expect(remote.left()).toEqual([...AFTER_FOUR_ATTEMPTS].sort());
    expect((await rows(store, "wi-lingtai-240"))[0]).toMatchObject({
      type: "IssueUpdateFailed",
      error: "403 secondary rate limit",
    });
  });
});

/**
 * **The sweep goes last within the item, whatever order the recipe wrote**
 * (`#240`).
 *
 * `tellGitHubAbout` used to carry the actions out in the order
 * `EndActionsResolved` holds them, which is the order the recipe declared — so
 * `end: [{refs: true}, {labels: [...]}]` deleted the arms and only then tried
 * the label write. The invariant the ordering exists for is that nothing
 * irreversible has happened when a later effect fails: a reader who then has to
 * work out what went wrong still has the branches to read. An ordering that
 * holds only for recipes written in the lucky order is not that invariant, so
 * it is enforced here and asserted here.
 */
describe("the order the end point's effects are carried out in", () => {
  /** Every call `tellGitHubAbout` may make, in the order it made them. */
  function fakeChannels(refs: readonly string[]) {
    const calls: string[] = [];
    const issue: IssueChannel = {
      getIssue: async () => ({ labels: [] }),
      comment: async () => {
        calls.push("comment");
        return { id: 1 };
      },
      setLabels: async (_n, labels) => {
        calls.push(`setLabels ${[...labels].join(",")}`);
      },
      closeIssue: async () => {
        calls.push("close");
      },
      updateBody: async () => {
        calls.push("updateBody");
      },
    };
    const held = new Set(refs);
    const ref: RefChannel = {
      matchingRefs: async (prefix) => [...held].filter((r) => r.startsWith(prefix)),
      deleteRef: async (r) => {
        calls.push(`deleteRef ${r}`);
        held.delete(r);
      },
    };
    return { github: { ...issue, ...ref }, calls };
  }

  const resolved = (actions: unknown[]): ToAppend =>
    ({
      type: "EndActionsResolved",
      actor: "conductor",
      data: { outcome: "landed", actions },
    }) as unknown as ToAppend;

  it("writes the labels before it deletes, even where `refs:` was declared first", async () => {
    const store = createMemoryEventStore();
    const world = fakeChannels([HEADS(BRANCH), HEADS(armBranch(BRANCH, 1))]);

    await tellGitHubAbout({
      store,
      github: world.github,
      workItemId: "wi-lingtai-240",
      appended: [
        resolved([
          { name: "sweep", refs: true, branch: false },
          { name: "label", labels: ["lingtai:done"] },
        ]),
      ],
    });

    expect(world.calls).toEqual([
      "setLabels lingtai:done",
      `deleteRef ${HEADS(armBranch(BRANCH, 1))}`,
    ]);
  });

  /**
   * And the order *among* the writes is still the recipe's, because it is a
   * decision rather than an accident: an issue closed and then labelled can
   * come back open, which is the ordering `tellGitHubAbout`'s header keeps.
   */
  it("leaves the writes in the order they were declared", async () => {
    const store = createMemoryEventStore();
    const world = fakeChannels([HEADS(armBranch(BRANCH, 1))]);

    await tellGitHubAbout({
      store,
      github: world.github,
      workItemId: "wi-lingtai-240",
      appended: [
        resolved([
          { name: "sweep", refs: true, branch: false },
          { name: "label", labels: ["lingtai:done"] },
          { name: "close", close: true },
        ]),
      ],
    });

    expect(world.calls).toEqual([
      "setLabels lingtai:done",
      "close",
      `deleteRef ${HEADS(armBranch(BRANCH, 1))}`,
    ]);
  });
});
