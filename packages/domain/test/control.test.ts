/**
 * The control fold, and the one thing in it that ends by itself.
 *
 * `ConductorPaused` carrying an `until` is
 * [0031](../../../doc/decisions/0031-a-run-that-never-started.md) §5 — the
 * first control state that lifts without anybody acting. The number it exists
 * to remove is twelve minutes: the limit lifted at 23:00 and the queue was
 * still idle at 23:12, waiting out a flat hour while the reset time sat in the
 * message it had been handed six times.
 *
 * The tests that matter here are the ones about what must **not** expire. A
 * pause a person made holds until they lift it, and a drain is a separate fact
 * that an expiring pause has no business touching.
 */
import { describe, expect, it } from "vitest";
import type { Envelope } from "../src/envelope.ts";
import { reduceControl } from "../src/control.ts";

function log(events: { type: string; data: unknown }[]): Envelope[] {
  return events.map(
    (e, i) =>
      ({
        seq: BigInt(i + 1),
        streamId: "ctl-conductor",
        version: i + 1,
        type: e.type,
        schemaVer: 1,
        data: e.data,
        actor: "conductor",
        causation: null,
        at: new Date(),
      }) as Envelope,
  );
}

const NOW = new Date("2026-09-09T08:44:14Z");
const RESET = "2026-09-10T04:00:00.000Z";

const quotaPause = {
  type: "ConductorPaused",
  data: { by: "lingtai", reason: "a run ended without ever starting", until: RESET },
};

describe("a pause that ends by itself", () => {
  it("holds until the instant it named", () => {
    const state = reduceControl(log([quotaPause]), NOW);

    expect(state.paused).toBe(true);
    expect(state.by).toBe("lingtai");
    expect(state.until?.toISOString()).toBe(RESET);
  });

  /**
   * Nothing is appended when it ends, and nothing has to be. The event that set
   * the expiry already says everything a reader needs, and an expiry that had
   * to be written down would be a second thing that can be missed — by exactly
   * the process that is not running, which is the case this exists for.
   */
  it("is over at that instant, with nobody having done anything", () => {
    const state = reduceControl(log([quotaPause]), new Date(RESET));

    expect(state.paused).toBe(false);
    expect(state.until).toBeNull();
    expect(state.reason).toBeNull();
  });

  /**
   * The half that must not start working. `lingtai pause` is somebody deciding
   * to stop the conductor, and a pause that quietly resumed itself would be a
   * hold they thought they had.
   */
  it("is not what a person's pause is", () => {
    const events = log([{ type: "ConductorPaused", data: { by: "human:steven", reason: "thinking" } }]);
    const state = reduceControl(events, new Date("2027-01-01T00:00:00Z"));

    expect(state.paused).toBe(true);
    expect(state.until).toBeNull();
    expect(state.by).toBe("human:steven");
  });

  /** A pause written before `until` existed is the pause it always was. */
  it("reads an unparseable or absent expiry as no expiry at all", () => {
    for (const until of [undefined, null, "", "eleven o'clock"]) {
      const events = log([{ type: "ConductorPaused", data: { by: "x", reason: "y", until } }]);
      const state = reduceControl(events, new Date("2099-01-01T00:00:00Z"));
      expect(state.paused, String(until)).toBe(true);
    }
  });

  it("is lifted early by a person, like any other", () => {
    const state = reduceControl(log([quotaPause, { type: "ConductorResumed", data: { by: "human:steven" } }]), NOW);

    expect(state.paused).toBe(false);
    expect(state.until).toBeNull();
  });

  /**
   * 0031's last consequence: a drain and a quota pause **compose**. One stops
   * taking work and exits, the other stops taking work and resumes, and they
   * are separate fields because they are separate facts (#77). An expiring
   * pause that cleared the drain would restart a daemon somebody had asked to
   * stop.
   */
  it("leaves a drain exactly where it found it, expired or not", () => {
    const events = log([
      { type: "ConductorShutdownRequested", data: { by: "human:steven", reason: "deploying", timeoutMs: null } },
      quotaPause,
    ]);

    const holding = reduceControl(events, NOW);
    expect(holding.paused).toBe(true);
    expect(holding.shutdown?.reason).toBe("deploying");

    const lifted = reduceControl(events, new Date(RESET));
    expect(lifted.paused).toBe(false);
    expect(lifted.shutdown?.reason).toBe("deploying");
  });
});
