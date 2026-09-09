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

/**
 * A question is a control instruction, so it lands where `pause` and `now` do
 * ([0033](../../../doc/decisions/0033-the-third-kind-of-agent.md) §3).
 */
describe("the discussions somebody asked for", () => {
  it("keeps every request, in order, answered or not", () => {
    const state = reduceControl(
      log([
        {
          type: "DiscussionRequested",
          data: {
            chatId: "chat-1",
            workItemId: "wi-lingtai-89",
            attempt: 2,
            question: "why did attempt 2 produce nothing?",
            by: "human:steven",
          },
        },
        {
          type: "DiscussionRequested",
          data: {
            chatId: "chat-1",
            workItemId: "wi-lingtai-89",
            attempt: null,
            question: "and the first?",
            by: "human:steven",
          },
        },
      ]),
      NOW,
    );

    expect(state.discussions).toHaveLength(2);
    expect(state.discussions[0]?.attempt).toBe(2);
    // A follow-up carries the same chat id: a conversation is a stream, not a
    // session, and nothing has to still be running between two questions.
    expect(state.discussions[1]?.chatId).toBe("chat-1");
  });

  /**
   * Whether a question has been *answered* is a fact on `chat-<id>`, so this
   * fold deliberately does not know it. Filtering here would put the second
   * half of a state machine on the control stream, which is the thing
   * `RunRequested` refuses to do.
   */
  it("does not decide whether a request is outstanding", () => {
    const state = reduceControl(
      log([
        {
          type: "DiscussionRequested",
          data: { chatId: "chat-1", workItemId: "wi-lingtai-89", attempt: null, question: "?", by: "human:steven" },
        },
        { type: "ConductorResumed", data: { by: "human:steven" } },
      ]),
      NOW,
    );

    // A resume lifts a pause and a drain. It does not withdraw a question.
    expect(state.discussions).toHaveLength(1);
  });
});
