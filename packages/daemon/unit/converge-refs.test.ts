/**
 * **A refs sweep GitHub refused is a job with an owner** (`#240`).
 *
 * `end`'s third effect deletes a landed item's `agent/<n>-attempt-<k>` refs, and
 * when GitHub says no — branch protection, a token without `contents: write`, a
 * secondary rate limit — `tell.ts` appends `IssueUpdateFailed {change:"refs"}`
 * and the run still lands. That row goes into `doctor`'s *computable* bucket,
 * where the sentence an operator reads is **"the next reconcile recomputes and
 * writes the difference"**.
 *
 * Nothing made that true. `Divergence.change` could not say `refs`,
 * `findIssueDrift` emitted nothing for one, and the sweep itself cannot be run
 * again: `resolveEndActions` returns `[]` once an `EndActionsResolved` exists
 * for that outcome, so `lingtai end replay` skips the item. The warning and the
 * arms were both permanent. These are the cases that hold the other way round.
 *
 * Unit, by 0060 §1: a memory log, a `streams()` that answers one id, and a
 * client that is a set of refs. No Postgres, no network, no `git`.
 */
import { describe, expect, it } from "vitest";
import { createMemoryEventStore } from "@lingtai/event-store/memory";
import type { EventStore } from "@lingtai/event-store";
import type { ProjectState } from "@lingtai/domain";
import type { GitHubClient } from "@lingtai/github";
import { agentBranch, armBranch } from "@lingtai/conductor/branches";
import { convergeIssues, findIssueDrift } from "../src/converge.ts";
import type { DaemonStore } from "../src/store.ts";

const PROJECT = "lingtai";
const ISSUE = 240;
const STREAM = `wi-${PROJECT}-${ISSUE}`;
const BRANCH = agentBranch(ISSUE);
const HEADS = (name: string) => `heads/${name}`;

const project: ProjectState = {
  project: PROJECT,
  owner: "steven-zhc",
  base: "main",
  configHash: "seeded",
  fromSha: "0".repeat(40),
  refused: null,
  version: 1,
  lastSeq: null,
};

/** The one stream this pass is to consider — `candidates()`' only job here. */
function oneStream(): DaemonStore {
  return { streams: async () => [STREAM] } as unknown as DaemonStore;
}

/**
 * A remote as a set of refs, and a closed issue carrying nothing.
 *
 * `refuseFrom` is a ref name at and after which `deleteRef` is declined, so a
 * sweep can be stopped part way down its own list.
 */
function fakeGitHub(refs: readonly string[], opts: { refuseFrom?: string } = {}) {
  const held = new Set(refs);
  const github = {
    getIssue: async (n: number) => ({
      number: n,
      title: "a ticket",
      body: "",
      labels: [],
      state: "closed" as const,
      url: `https://example.invalid/${n}`,
      dependencies: { blockedBy: 0, totalBlockedBy: 0 },
      assignees: [],
    }),
    matchingRefs: async (prefix: string) => [...held].filter((ref) => ref.startsWith(prefix)),
    deleteRef: async (ref: string) => {
      if (opts.refuseFrom !== undefined && ref >= opts.refuseFrom) {
        throw new Error("403 secondary rate limit");
      }
      held.delete(ref);
    },
  } as unknown as GitHubClient;
  return { github, left: () => [...held].sort() };
}

/** A landed item that resolved a sweep and was refused it. */
async function seedRefusedSweep(
  store: EventStore,
  opts: { branch?: boolean; error?: string } = {},
): Promise<void> {
  await store.append(STREAM, 0, [
    {
      type: "EndActionsResolved",
      actor: "conductor",
      data: {
        outcome: "landed",
        actions: [{ name: "sweep", refs: true, branch: opts.branch ?? false }],
      } as never,
    },
    {
      type: "IssueUpdateFailed",
      actor: "conductor",
      data: {
        project: PROJECT,
        issue: String(ISSUE),
        change: "refs",
        error: opts.error ?? "403 resource not accessible by integration",
      } as never,
    },
  ]);
}

/** Every `refs` row this stream holds, newest last. */
async function refsRows(store: EventStore) {
  return (await store.read(STREAM))
    .filter((e) => e.type === "IssueUpdated" || e.type === "IssueUpdateFailed")
    .map((e) => ({ type: e.type, ...(e.data as { change: string; detail?: string; error?: string }) }))
    .filter((r) => r.change === "refs");
}

function options(store: EventStore, github: GitHubClient) {
  return {
    store,
    daemonStore: oneStream(),
    projects: [project],
    clients: new Map([[PROJECT, github]]),
  };
}

const AFTER_FOUR_ATTEMPTS = [
  HEADS(BRANCH),
  HEADS(armBranch(BRANCH, 1)),
  HEADS(armBranch(BRANCH, 2)),
  HEADS(armBranch(BRANCH, 3)),
  HEADS(armBranch(BRANCH, 4)),
];

describe("a refs sweep the log says was refused", () => {
  /**
   * **The case `doctor`'s sentence was promising and nothing delivered.** The
   * divergence has to exist before anything can converge it.
   */
  it("is found as a divergence naming the arms still on origin", async () => {
    const store = createMemoryEventStore();
    await seedRefusedSweep(store);
    const remote = fakeGitHub(AFTER_FOUR_ATTEMPTS);

    const found = await findIssueDrift(options(store, remote.github));

    expect(found).toEqual([
      {
        workItemId: STREAM,
        project: PROJECT,
        issue: ISSUE,
        change: "refs",
        expected: [1, 2, 3, 4].map((n) => HEADS(armBranch(BRANCH, n))).join(", "),
        actual: "4 still on origin — the log says the sweep asked and did not manage",
      },
    ]);
  });

  /** And a reconcile deletes them, records it, and goes quiet on the next pass. */
  it("is converged, and does not come back", async () => {
    const store = createMemoryEventStore();
    await seedRefusedSweep(store);
    const remote = fakeGitHub(AFTER_FOUR_ATTEMPTS);
    const opts = options(store, remote.github);

    const { converged } = await convergeIssues(opts);

    expect(converged.map((d) => d.change)).toEqual(["refs"]);
    expect(remote.left()).toEqual([HEADS(BRANCH)]);
    expect((await refsRows(store)).at(-1)).toMatchObject({
      type: "IssueUpdated",
      change: "refs",
    });
    // The log agrees with itself again, so there is nothing to report — the
    // property `convergeIssues` has rather than a resolved flag somewhere.
    expect(await findIssueDrift(opts)).toEqual([]);
  });

  /**
   * **`branch:` is the recipe's decision and convergence must not widen it.**
   * An item swept with `branch: false` keeps `agent/<n>` however many times the
   * sweep is retried — it is the ref a person follows from the merge commit.
   */
  it("keeps `agent/<n>` where the resolution did not ask for it, and takes it where it did", async () => {
    const kept = createMemoryEventStore();
    await seedRefusedSweep(kept, { branch: false });
    const keptRemote = fakeGitHub(AFTER_FOUR_ATTEMPTS);
    await convergeIssues(options(kept, keptRemote.github));
    expect(keptRemote.left()).toEqual([HEADS(BRANCH)]);

    const taken = createMemoryEventStore();
    await seedRefusedSweep(taken, { branch: true });
    const takenRemote = fakeGitHub(AFTER_FOUR_ATTEMPTS);
    await convergeIssues(options(taken, takenRemote.github));
    expect(takenRemote.left()).toEqual([]);
  });

  /**
   * A refusal here is recorded the way `sweepRefs` records one — **with the
   * names of what had already gone**, because a delete is one call per ref and
   * the remote cannot be asked afterwards which ones went.
   */
  it("names what it deleted before a second refusal, and leaves the rest owed", async () => {
    const store = createMemoryEventStore();
    await seedRefusedSweep(store);
    const remote = fakeGitHub(AFTER_FOUR_ATTEMPTS, { refuseFrom: HEADS(armBranch(BRANCH, 3)) });
    const opts = options(store, remote.github);

    const { converged } = await convergeIssues(opts);

    expect(converged).toEqual([]);
    expect((await refsRows(store)).at(-1)).toMatchObject({
      type: "IssueUpdateFailed",
      error:
        `403 secondary rate limit — after deleting ${HEADS(armBranch(BRANCH, 1))},` +
        HEADS(armBranch(BRANCH, 2)),
    });
    // And the two it could not delete are still owed, so the next pass finishes
    // the job rather than starting it again.
    expect(await findIssueDrift(opts)).toMatchObject([
      { change: "refs", expected: [HEADS(armBranch(BRANCH, 3)), HEADS(armBranch(BRANCH, 4))].join(", ") },
    ]);
  });

  /**
   * **A sweep nobody resolved is not a divergence.** An item whose recipe
   * declares no `refs:` effect has its arms on purpose, so the failure row is
   * the condition and the resolution is the licence — neither alone.
   */
  it("leaves the arms of an item that resolved no sweep alone", async () => {
    const store = createMemoryEventStore();
    await store.append(STREAM, 0, [
      {
        type: "IssueUpdateFailed",
        actor: "conductor",
        data: { project: PROJECT, issue: String(ISSUE), change: "comment", error: "502" } as never,
      },
    ]);
    const remote = fakeGitHub(AFTER_FOUR_ATTEMPTS);

    const found = await findIssueDrift(options(store, remote.github));

    expect(found.map((d) => d.change)).toEqual(["comment"]);
    expect(remote.left()).toEqual([...AFTER_FOUR_ATTEMPTS].sort());
  });

  /**
   * And an item whose sweep was refused but whose arms are gone anyway —
   * somebody deleted them by hand — gets no write, which is the property that
   * makes this convergence and not replay.
   */
  it("writes nothing where the arms are already gone", async () => {
    const store = createMemoryEventStore();
    await seedRefusedSweep(store);
    const remote = fakeGitHub([HEADS(BRANCH)]);

    expect(await findIssueDrift(options(store, remote.github))).toEqual([]);
  });
});
