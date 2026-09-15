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
import { Actor } from "../src/envelope.ts";
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

/**
 * A withdrawal is history now (0045): nothing appends one, and the log keeps
 * every one written before. Replay has to read them as it always did, so this is
 * what they meant, asserted — not a behaviour anything relies on going forward.
 */
describe("a withdrawal already in the log", () => {
  const asked = (by: string, reason: string) => ({
    type: "ConductorShutdownRequested",
    data: { by, reason, timeoutMs: null },
  });

  it("lifts the request it names, and leaves a pause exactly as it was", () => {
    const state = reduceControl(
      log([
        { type: "ConductorPaused", data: { by: "human:ops", reason: "the importer is flaky", until: null } },
        asked("human:steven", "restarting: picking up #88"),
        { type: "ConductorShutdownWithdrawn", data: { by: "human:steven", version: 2, reason: "restarted" } },
      ]),
      NOW,
    );

    expect(state.shutdown).toBeNull();
    expect(state.paused).toBe(true);
    expect(state.by).toBe("human:ops");
  });

  it("does not lift a newer request somebody else made", () => {
    const state = reduceControl(
      log([
        asked("human:steven", "restarting: picking up #88"),
        asked("human:ops", "the database is being moved"),
        { type: "ConductorShutdownWithdrawn", data: { by: "human:steven", version: 1, reason: "restarted" } },
      ]),
      NOW,
    );

    expect(state.shutdown).toEqual({ by: "human:ops", reason: "the database is being moved", timeoutMs: null, force: false, version: 2 });
  });
});

/**
 * A request does not outlive the daemon it was aimed at (0045).
 *
 * The daemon already reads the stream from its own start (`#159`); this is the
 * same fact for every reader that folds the whole stream — the board's chip,
 * `lingtai doctor`, `service start`'s refusal, and a restart deciding whether
 * somebody else's drain stands. Without it they would go on reporting a drain
 * that the daemon it was aimed at had already performed.
 */
describe("a start ends what was said before it", () => {
  const asked = { type: "ConductorShutdownRequested", data: { by: "human:steven", reason: "stopping for the day", timeoutMs: null } };
  const started = { type: "ConductorStarted", data: { by: "human:steven", reason: null, sha: "2926f2d", dirty: false, worker: "h:1", handoff: null } };

  it("ends a standing request, with nothing appended to take it back", () => {
    expect(reduceControl(log([asked]), NOW).shutdown).not.toBeNull();
    expect(reduceControl(log([asked, started]), NOW).shutdown).toBeNull();
  });

  it("leaves a request made after it standing — that one is the running daemon's", () => {
    expect(reduceControl(log([asked, started, asked]), NOW).shutdown?.version).toBe(3);
  });

  it("leaves a pause alone, which is a different axis and not this decision", () => {
    const pause = { type: "ConductorPaused", data: { by: "human:ops", reason: "x", until: null } };
    expect(reduceControl(log([pause, started]), NOW).paused).toBe(true);
  });
});

/**
 * A restart under launchd or systemd hands its start to the supervisor, and the
 * handoff is how the daemon the supervisor starts knows whose restart it is
 * (0042 §8). It rides on the restart's own request since 0045, which deleted
 * the withdrawal it used to ride on.
 */
describe("a restart's handoff to the supervisor", () => {
  const handing = {
    type: "ConductorShutdownRequested",
    data: { by: "human:steven", reason: "restarting: picking up #88", timeoutMs: null, handoff: { sha: "2926f2d", dirty: false } },
  };

  it("stands on the request that carries it, naming who, why, the commit and the request's version", () => {
    expect(reduceControl(log([handing]), NOW).handoff).toEqual({
      by: "human:steven",
      reason: "restarting: picking up #88",
      sha: "2926f2d",
      dirty: false,
      version: 1,
    });
  });

  it("is ended by the next start, whoever made it", () => {
    const started = { type: "ConductorStarted", data: { by: "human:ops", reason: null, sha: "2926f2d", dirty: false, worker: "h:1", handoff: null } };
    expect(reduceControl(log([handing, started]), NOW).handoff).toBeNull();
  });

  /**
   * The lapse is gone, and this is why it had to be: the handoff is on a request
   * appended *before* the drain, and a drain takes up to an hour. Five minutes
   * from the request would have expired during the very drain it waits on.
   */
  it("does not lapse on the clock, since the drain it waits for can take an hour", () => {
    const events = log([handing]).map((ev) => ({ ...ev, at: new Date("2026-09-13T23:06:00Z") }));
    expect(reduceControl(events, new Date("2026-09-14T00:10:00Z")).handoff).not.toBeNull();
  });

  it("is superseded by a newer drain, and is not set by a request that carries none", () => {
    const plain = { type: "ConductorShutdownRequested", data: { by: "human:ops", reason: "moving", timeoutMs: null } };
    expect(reduceControl(log([handing, plain]), NOW).handoff).toBeNull();
    expect(reduceControl(log([plain]), NOW).handoff).toBeNull();
  });

  it("is not set by a withdrawal already in the log", () => {
    const old = {
      type: "ConductorShutdownWithdrawn",
      data: { by: "human:steven", version: 1, reason: "restarted", handoff: { sha: "2926f2d", dirty: false } },
    };
    const asked = { type: "ConductorShutdownRequested", data: { by: "human:steven", reason: "restarting", timeoutMs: null } };
    expect(reduceControl(log([asked, old]), NOW).handoff).toBeNull();
  });
});

/**
 * Who may append, and the one that could not (`#159`).
 *
 * `ConductorStarted.by` has always documented `daemon` as what a supervisor's
 * start is recorded as — launchd's `KeepAlive`, a systemd unit, a `nohup` —
 * "because the log saying a person started what launchd started by itself is
 * the unattributable 23:06 again". `Actor` did not admit it, so every one of
 * those appends failed and printed its ZodError into a log nobody reads. The
 * documented design, refused by the validator.
 *
 * What it cost is what 0042 exists to prevent: *who restarted it at 23:06* was
 * unanswerable for exactly the starts nobody witnessed. This is the assertion
 * that stops it going quiet again.
 */
describe("who may append", () => {
  it("accepts a supervisor's start", () => {
    expect(Actor.safeParse("daemon").success).toBe(true);
  });

  it("accepts the other four", () => {
    for (const who of ["conductor", "github", "agent:run-1a2b", "human:steven"]) {
      expect(Actor.safeParse(who).success, who).toBe(true);
    }
  });

  it("still refuses a name that is none of them", () => {
    // The point of the pattern: an actor is a closed set, so a typo is a
    // refusal rather than a new kind of appender nobody decided on.
    for (const who of ["", "launchd", "human:", "agent:", "Daemon"]) {
      expect(Actor.safeParse(who).success, who).toBe(false);
    }
  });
});
