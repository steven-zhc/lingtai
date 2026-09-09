/**
 * `lingtai run` is a conductor, and there is only one (#93).
 *
 * The exclusion is the whole point, so a fake lock would test nothing: what has
 * to be true is that a `lingtai run` started beside something already
 * conducting **stops before it claims** — and stops the way `lingtai daemon`
 * does, with a line naming the holder and exit 0, not a stack trace.
 *
 * The claim mechanism used to hide this. A live thirty-minute lease turned the
 * second claimant away, so the gap only opened on runs longer than half an hour
 * — and [0027](../../../doc/decisions/0027-the-lease-is-deleted.md) deletes the
 * lease and puts the proof on this lock instead.
 *
 * Its own key, so the suite does not fight the operator's daemon.
 */
import { acquireDaemonLock, conductorLockHolder } from "@lingtai/daemon";
import { describe, expect, it } from "vitest";
import { run } from "../src/run.ts";

const key = () => `lingtai:test:${crypto.randomUUID().slice(0, 8)}`;

describe("lingtai run and the conductor lock", () => {
  it("refuses rather than claims while something else holds the lock", async () => {
    const k = key();
    const held = await acquireDaemonLock({ key: k, name: "lingtai daemon" });
    expect(held.ok).toBe(true);
    if (!held.ok) return;

    const lines: string[] = [];
    try {
      // A real project name would make no difference: the point is that it
      // never gets far enough to look one up.
      const code = await run({ project: "esctest-never-looked-up", lockKey: k }, (l) => lines.push(l));

      // Exit 0. Typing this while the daemon is up is a reasonable thing to do,
      // and an error here would teach people to ignore errors.
      expect(code).toBe(0);

      // Who has it, from the read `lingtai doctor` does — which never takes the
      // lock, and so can answer this while somebody else holds it. Asserted on
      // the reader rather than on the printed line: `application_name` is the
      // backend's own, and a pooler in front of Postgres reports its own name.
      expect(await conductorLockHolder({ key: k })).toBeTruthy();
    } finally {
      await held.lock.release();
    }

    const said = lines.join("\n");
    expect(said).toContain("another conductor holds the lock");

    // **It stopped before it claimed** — and before it read anything at all.
    // Every one of these lines is a stage it would have reached had the lock not
    // turned it away, so their absence is the assertion, not the exit code.
    expect(said).not.toContain("no project named");
    expect(said).not.toContain("GitHub App");
    expect(said).not.toContain("run(s)");
  }, 60_000);

  it("releases the lock on the way out, including when it refuses", async () => {
    const k = key();
    // Nothing holds it, so this run takes it — and then refuses, because a
    // throwaway name is not a registered project or there is no App to ask
    // with. Either way it returns through a path that is not the happy one,
    // which is exactly the path an advisory lock gets stranded on.
    await run({ project: "esctest-never-registered", lockKey: k }, () => {});

    expect(await conductorLockHolder({ key: k })).toBeNull();

    const after = await acquireDaemonLock({ key: k });
    expect(after.ok).toBe(true);
    if (after.ok) await after.lock.release();
  }, 60_000);
});
