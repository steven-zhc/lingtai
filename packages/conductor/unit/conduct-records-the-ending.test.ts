/**
 * **An ending and what `end` resolved for it are one append** — the rule
 * `resolveEndActions` states as its own reason for taking a stream rather than a
 * store: *one transaction, so the outcome and its resolution cannot come apart*
 * (`end-step.ts`).
 *
 * Under the ten steps that rule is a claim about two files. `runPass` runs `end`
 * after the walk and before `conduct.ts` writes `WorkItemLanded` or
 * `WorkItemBlocked`, so the caller has to *hold* what the step resolved and
 * append it beside the ending — which is what `PassPorts.recordEnd` means by
 * *batching is the caller's because the ending is the caller's*. A port that
 * appended on the spot reversed the order instead, and the window it opened is
 * the expensive kind rather than a tidiness argument:
 *
 *   `EndActionsResolved{landed}` lands, the next append meets the dropped
 *   connection CLAUDE.md documents against `#157`, and the commit is on the base
 *   branch with no landing on the log — so `reduceWorkItem` reads `backlog`, the
 *   issue is relabelled `lingtai:queued`, and the next queue pass buys a whole
 *   agent to re-implement merged work.
 *
 *   And it cannot be found afterwards. The point resolves **once per outcome**,
 *   so the real landing can never resolve `end` again, and
 *   `endedWithoutEndActions` finds the matching `landed` row and reports nothing
 *   wrong.
 *
 * The same window on a hold recorded a `when: blocked` action as carried out for
 * a block that was never recorded.
 *
 * Unit by [0060](../../../doc/decisions/0060-the-gate-runs-unit-tests.md) §1: no
 * process, no socket, no network. The fixtures are `test/one-pass.ts`.
 */
import type { Envelope, ToAppend } from "@lingtai/domain";
import { describe, expect, it } from "vitest";
import {
  PROJECT,
  RECIPE,
  fakeGitHub,
  fakePorts,
  memoryStore,
  once,
  project,
  runtime,
} from "../test/one-pass.ts";

/** `RECIPE`, with one `end` action that fires on the outcome named. */
const closingOn = (when: "landed" | "blocked") =>
  RECIPE.replace(
    "steps: {}",
    `steps:\n  end:\n    - { name: close it, when: ${when}, close: true }`,
  );

describe("the ending and its end actions", () => {
  it("records the landing and what `end` resolved in one append", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const said: string[] = [];

    const result = await once(
      {
        project,
        client: fakeGitHub(said, closingOn("landed")),
        runtime,
        issue: 7,
        hookBinary: "/tmp/fake/lingtai-hook",
        prompt: "fix {{issue}}",
        merge: true,
        home: "/tmp/fake-home",
        store,
      },
      fakePorts(did, store, true),
    );

    if (result.ok === false) throw new Error(`stopped at ${result.stage}: ${result.detail}`);
    expect(result.ok).toBe(true);

    const item = await store.read(`wi-${PROJECT}-7`);
    // **Immediately after the landing**, which is what one append looks like from
    // the outside: nothing of this run's can be interleaved between them.
    const at = item.findIndex((e) => e.type === "WorkItemLanded");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(item[at + 1]?.type).toBe("EndActionsResolved");
    expect(item[at + 1]!.data).toEqual({
      outcome: "landed",
      actions: [{ name: "close it", close: true }],
    });

    // And carried out, which is `tellGitHubAbout` reading the plan the append
    // returned rather than the stream (`tell.ts`).
    expect(said).toContain("close #7");
    expect(item.map((e) => e.type)).not.toContain("IssueUpdateFailed");
  });

  /**
   * **The window itself, as the failure it was.** The store takes everything but
   * the append that carries `WorkItemLanded`, which is the dropped connection
   * arriving on exactly the row it costs the most.
   *
   * What must not be on the stream afterwards is the resolution. The merge is on
   * the base branch and the log has lost it either way — no design recovers
   * that — but a `landed` row over it is the part that makes the loss permanent
   * and invisible: nothing can resolve `end` for that outcome again, and the
   * audit that exists to find it reports nothing wrong.
   */
  it("records nothing about `end` when the landing itself was not recorded", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const said: string[] = [];
    const refusing: typeof store = {
      ...store,
      append: async (streamId: string, expected: number, events: readonly ToAppend[]) => {
        if (events.some((e) => e.type === "WorkItemLanded")) {
          throw new Error("terminating connection due to administrator command");
        }
        return store.append(streamId, expected, events) as Promise<Envelope[]>;
      },
    };

    const result = await once(
      {
        project,
        client: fakeGitHub(said, closingOn("landed")),
        runtime,
        issue: 7,
        hookBinary: "/tmp/fake/lingtai-hook",
        prompt: "fix {{issue}}",
        merge: true,
        home: "/tmp/fake-home",
        store: refusing,
      },
      fakePorts(did, refusing, true),
    );

    // The defect channel, because an append the store will not take is a bug and
    // not a refusal this run can make on anybody's behalf.
    expect(result).toMatchObject({ ok: false, stage: "unexpected" });

    const types = (await store.read(`wi-${PROJECT}-7`)).map((e) => e.type);
    // Neither the landing nor a word about `end`.
    expect(types).not.toContain("WorkItemLanded");
    expect(types).not.toContain("EndActionsResolved");
    // The item is back in the queue, which is what the defect handler's release
    // makes true — and the `landed` plan is not carried in on it.
    expect(types).toContain("WorkItemReleased");
    // So nothing was done to the issue on the strength of a landing nothing
    // recorded.
    expect(said).not.toContain("close #7");
  });

  it("records the block and what `end` resolved in one append", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const said: string[] = [];

    const result = await once(
      {
        project,
        client: fakeGitHub(said, closingOn("blocked")),
        runtime,
        issue: 7,
        hookBinary: "/tmp/fake/lingtai-hook",
        prompt: "fix {{issue}}",
        merge: false,
        home: "/tmp/fake-home",
        store,
      },
      fakePorts(did, store),
    );

    expect(result).toMatchObject({ ok: "held", step: "merge" });

    const item = await store.read(`wi-${PROJECT}-7`);
    const at = item.findIndex((e) => e.type === "WorkItemBlocked");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(item[at + 1]?.type).toBe("EndActionsResolved");
    expect(item[at + 1]!.data).toMatchObject({ outcome: "blocked" });
    expect(said).toContain("close #7");
  });
});
