/**
 * **Which of a ticket's arms `origin` holds** (#315), against a fake of the one
 * GitHub call it makes. No network.
 */
import { describe, expect, it } from "vitest";
import { type ArmChannel, armsOnOrigin } from "../src/arms.ts";

/** A remote's refs, answered by plain string prefix the way GitHub answers. */
function fakeRefs(refs: readonly string[], opts: { fail?: boolean } = {}) {
  const asked: string[] = [];
  const channel: ArmChannel = {
    async matchingRefs(prefix) {
      asked.push(prefix);
      if (opts.fail) throw new Error("404 not found");
      return refs.filter((ref) => ref.startsWith(prefix));
    },
  };
  return { channel, asked };
}

describe("armsOnOrigin", () => {
  it("names the arms, without the `heads/` GitHub puts on them", async () => {
    const { channel, asked } = fakeRefs([
      "heads/agent/314",
      "heads/agent/314-attempt-1",
      "heads/agent/314-attempt-3",
    ]);

    const arms = await armsOnOrigin(channel, "agent/314");
    expect(asked).toEqual(["heads/agent/314-attempt-"]);
    expect(arms?.branch).toBe("agent/314");
    expect([...(arms?.onOrigin ?? [])].sort()).toEqual([
      "agent/314-attempt-1",
      "agent/314-attempt-3",
    ]);
  });

  /** GitHub matches by string, so `agent/24` must not pick up `agent/240`'s arms. */
  it("does not take a neighbour's arms", async () => {
    const { channel } = fakeRefs(["heads/agent/240-attempt-1", "heads/agent/24-attempt-2"]);
    // A remote that answered more than it was asked for, as a plain prefix would.
    const loose: ArmChannel = { matchingRefs: () => channel.matchingRefs("heads/agent/24") };

    const arms = await armsOnOrigin(loose, "agent/24");
    expect([...(arms?.onOrigin ?? [])]).toEqual(["agent/24-attempt-2"]);
  });

  it("is an empty set when origin has none", async () => {
    const arms = await armsOnOrigin(fakeRefs(["heads/agent/314"]).channel, "agent/314");
    expect(arms?.onOrigin.size).toBe(0);
  });

  /** A throw is never an absence: it is *could not ask*, and says so as null. */
  it("is null, not empty, when the remote could not be asked", async () => {
    const arms = await armsOnOrigin(fakeRefs([], { fail: true }).channel, "agent/314");
    expect(arms).toBeNull();
  });
});
