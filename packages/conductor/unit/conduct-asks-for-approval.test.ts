/**
 * **What the conductor asks a person, when nothing at the point asked for
 * them.**
 *
 * A plugin that wants a person emits its own `ApprovalRequested` through the
 * pipeline; a plugin that *refused* emits a `GateFailed` and nothing else, so
 * the request that reaches a person over a refusal is `conduct.ts`'s own — and
 * the two events land in the same place.
 *
 * `task-view.ts` folds both through one `setStep`, keyed
 * `${runId}:${gate}:${action}`, with `VERDICT.GateFailed = "failed"` and
 * `VERDICT.ApprovalRequested = "pending"`. **So the name on the request is not
 * decoration.** Named after the action that refused, the request overwrites
 * that action's verdict with `pending`: the card's `failed` count drops to zero
 * and the board shows a change that was refused as merely waiting, on every
 * projection and every rebuild. `run-once.ts` named its request `unfixed` or
 * `disagreement` for precisely this reason and wrote the collision out in a
 * comment at the append; the name is what survived the engine swap badly.
 *
 * Unit by [0060](../../../doc/decisions/0060-the-gate-runs-unit-tests.md) §1:
 * no process, no socket, no network. The fixtures are `test/one-pass.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  PROJECT,
  fakeGitHub,
  fakePorts,
  memoryStore,
  once,
  project,
  refusingRuntime,
  restartRecipe,
  streams,
} from "../test/one-pass.ts";

describe("the approval a refusal reaches a person with", () => {
  /**
   * A cold reviewer that refuses, and no round to patch with.
   *
   * `rounds: 0` is the shortest path: the review refuses the first diff,
   * `onOffer` has no `implement` left to offer, and a `findings` direction has
   * no built-in judge (`BUILT_IN_FOR`) — so the floor `#253` set holds and the
   * pass reaches a person with `proposed` named as where it stopped.
   */
  const refused = async () => {
    const store = memoryStore();
    const did: string[] = [];
    const said: string[] = [];

    const result = await once(
      {
        project,
        client: fakeGitHub(said, restartRecipe(0)),
        runtime: refusingRuntime,
        issue: 7,
        hookBinary: "/tmp/fake/lingtai-hook",
        prompt: "fix {{issue}}",
        merge: false,
        home: "/tmp/fake-home",
        store,
      },
      fakePorts(did, store),
    );
    const [, run] = [...streams(store)].find(([id]) => id.startsWith("run-"))!;
    return { result, run, item: await store.read(`wi-${PROJECT}-7`) };
  };

  it("is named for itself, so the refusal it reports is not overwritten", async () => {
    const { result, run, item } = await refused();

    expect(result).toMatchObject({ ok: "held", step: "proposed" });

    const failed = run.find((e) => e.type === "GateFailed")!;
    expect(failed.data).toMatchObject({ gate: "proposed", action: "review" });

    const asked = run.find((e) => e.type === "ApprovalRequested")!;
    const key = (data: unknown) => {
      const d = data as { gate: string; action: string };
      return `${d.gate}:${d.action}`;
    };
    // The whole of it: one key per verdict, so the `pending` cannot land on the
    // `failed`.
    expect(key(asked.data)).not.toBe(key(failed.data));
    expect((asked.data as { action: string }).action).toBe("unfixed");

    // **And what the key stops carrying travels in the question**, which is
    // what a person reads — the pointer to the action, and the step it ran at.
    const question = (asked.data as { question: string }).question;
    expect(question).toContain("review");
    expect(question).toContain("proposed");

    // The card's own sentence still names the refusal, and this is a diff two
    // agents disagreed about rather than a green run — so no move is
    // recommended over it.
    const blocked = item.find((e) => e.type === "WorkItemBlocked")!;
    expect(blocked.data).toMatchObject({ needs: "acknowledgement" });
    expect(
      (blocked.data as { diagnosis: { recommendation: unknown } }).diagnosis.recommendation,
    ).toBeNull();
  });
});
