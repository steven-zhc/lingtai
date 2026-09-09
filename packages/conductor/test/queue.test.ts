/**
 * The subtraction: what GitHub offers, minus what the log says is claimed.
 *
 * Lives beside `selectRunnable` rather than beside the projection it reads.
 * The fold is `projector`'s and is tested there; the *decision* about what to
 * take next is the conductor's, and this is that decision — the seam 0022 drew
 * between a projection and a caller that reads one.
 */
import { directDatabaseUrl } from "@lingtai/env";
import { createDb, createEventStore, type Db, type EventStore } from "@lingtai/event-store";
import { createProjectionRunner } from "@lingtai/projector";
import { taskViewProjection } from "@lingtai/projector";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { heldUntil, inWords, selectRunnable } from "../src/index.ts";

/**
 * An hour, as `source.backoff` resolves to for a recipe that does not mention
 * it. Named here rather than imported: it is the *recipe's* default now (0028),
 * and a test that read it back off the schema would agree with itself.
 */
const HOUR = 60 * 60_000;

const created = new Set<string>();
let client: Db;
let store: EventStore;

/** The projection has to exist before the queue can subtract from it. */
async function build(): Promise<void> {
  const runner = createProjectionRunner({ projection: taskViewProjection, store });
  try {
    await runner.start();
  } finally {
    await runner.close();
  }
}

beforeAll(async () => {
  client = createDb();
  store = createEventStore(client);
}, 120_000);

afterAll(async () => {
  await client.close();
  const c = new pg.Client({ connectionString: directDatabaseUrl() });
  await c.connect();
  try {
    await c.query("alter table events disable rule lingtai_events_no_delete");
    await c.query("delete from events where stream_id = any($1)", [[...created]]);
  } finally {
    await c.query("alter table events enable rule lingtai_events_no_delete");
    await c.end();
  }
});

describe("selectRunnable", () => {
  const other = `esctest${crypto.randomUUID().slice(0, 6)}`;

  /**
   * The subtraction. GitHub's offer is an argument now rather than a table, so
   * what is being tested is the rule and not a cache's freshness.
   */
  it("offers what GitHub lists, minus what the log says is claimed", async () => {
    const offered = [
      { ref: "10", title: "one", kind: "bug" },
      { ref: "11", title: "two", kind: "feature" },
    ];
    const kinds = ["bug", "feature"];

    // No rows at all: the log has no opinion about either, so both are runnable.
    const before = await selectRunnable({ project: other, offered, kinds, backoffMs: HOUR });
    expect(before.map((r) => r.issue)).toEqual(["10", "11"]);
    expect(before[0]).toEqual({ taskId: `wi-${other}-10`, issue: "10", title: "one", kind: "bug" });

    const claimedId = `wi-${other}-10`;
    created.add(claimedId);
    await store.append(claimedId, 0, [
      { type: "WorkItemClaimed", actor: "conductor", data: { runId: `run-${other}-10`, worker: "w", leaseUntilMs: Date.now() + 60_000, title: null, kind: null } },
    ]);
    created.add(`run-${other}-10`);
    await build();

    // GitHub still lists 10. The log is the authority on what happened after
    // the claim, and it says the claim happened.
    expect((await selectRunnable({ project: other, offered, kinds, backoffMs: HOUR })).map((r) => r.issue)).toEqual([
      "11",
    ]);

    // GitHub stops listing 11 — closed by a person. Nothing has to be
    // invalidated, because nothing was stored: it is simply not in the offer.
    const narrowed = await selectRunnable({ project: other, offered: [offered[0]!], kinds, backoffMs: HOUR });
    expect(narrowed).toEqual([]);
  });

  /** Priority is the recipe's `kinds` order, and ties break numerically. */
  it("puts the recipe's first kind first, and orders by issue number inside it", async () => {
    const fresh = `esctest${crypto.randomUUID().slice(0, 6)}`;
    const runnable = await selectRunnable({
      project: fresh,
      offered: [
        { ref: "9", title: "b", kind: "bug" },
        { ref: "100", title: "f", kind: "feature" },
        { ref: "20", title: "b2", kind: "bug" },
      ],
      kinds: ["feature", "bug"],
      backoffMs: HOUR,
    });
    // #100 beats both bugs on kind; #9 beats #20 numerically, not lexically.
    expect(runnable.map((r) => r.issue)).toEqual(["100", "9", "20"]);
  });

  /** A kind the recipe does not want is not offered, whatever GitHub says. */
  it("drops a kind the recipe does not take", async () => {
    const fresh = `esctest${crypto.randomUUID().slice(0, 6)}`;
    const runnable = await selectRunnable({
      project: fresh,
      offered: [{ ref: "1", title: "c", kind: "chore" }],
      kinds: ["bug"],
      backoffMs: HOUR,
    });
    expect(runnable).toEqual([]);
  });

  /**
   * The loop guard itself, which had no test — the thing `#95` found was that
   * the hour was in a constant, a roadmap checkbox and nowhere else.
   *
   * An attempt is a claim, so the row's `last_attempt_at` is written by the
   * claim and survives the release that puts the item back in the queue. Both
   * sides of the window are checked from the same log by moving `now`, which is
   * why `now` is injectable at all.
   */
  it("holds a released item for the backoff, and offers it once the window passes", async () => {
    const project = `esctest${crypto.randomUUID().slice(0, 6)}`;
    const item = `wi-${project}-7`;
    const runId = `run-${crypto.randomUUID()}`;
    created.add(item);
    created.add(runId);
    const offered = [{ ref: "7", title: "flaky", kind: "bug" }];
    const kinds = ["bug"];

    await store.append(item, 0, [
      {
        type: "WorkItemClaimed",
        actor: "conductor",
        data: { runId, worker: "w", leaseUntilMs: Date.now() + 60_000, title: null, kind: null },
      },
      {
        type: "WorkItemReleased",
        actor: "conductor",
        data: { runId, reason: "the gate failed" },
      },
    ]);
    await build();

    const attemptedAt = (await readAttempt(project)) as Date;

    // Released, so the row is `queued` again — and that is exactly the loop the
    // backoff exists to break: the release is the completion event that starts
    // the next pass.
    const straightAway = await selectRunnable({
      project,
      offered,
      kinds,
      backoffMs: HOUR,
      now: new Date(attemptedAt.getTime() + 59 * 60_000),
    });
    expect(straightAway).toEqual([]);

    const later = await selectRunnable({
      project,
      offered,
      kinds,
      backoffMs: HOUR,
      now: new Date(attemptedAt.getTime() + HOUR),
    });
    expect(later.map((r) => r.issue)).toEqual(["7"]);

    // And the same log with a shorter window says the opposite, which is the
    // whole of "the recipe decides" (0028).
    const impatient = await selectRunnable({
      project,
      offered,
      kinds,
      backoffMs: 60_000,
      now: new Date(attemptedAt.getTime() + 5 * 60_000),
    });
    expect(impatient.map((r) => r.issue)).toEqual(["7"]);

    await drop(project);
  });

  afterAll(async () => {
    await drop(other);
  });
});

/**
 * The rule read forwards, so that something can be *said* about a held item.
 * Pure, and tested as such: the arithmetic is what the board and `lingtai
 * status` put in front of a person, and it should not need a database.
 */
describe("heldUntil", () => {
  const at = new Date("2026-09-08T12:00:00Z");
  const now = at.getTime() + 10 * 60_000;

  it("says when the window ends, while it is still open", () => {
    const until = heldUntil({ lastAttemptAt: at, repairPending: false }, HOUR, now);
    expect(until?.toISOString()).toBe("2026-09-08T13:00:00.000Z");
  });

  it("holds nothing once the window has passed", () => {
    expect(heldUntil({ lastAttemptAt: at, repairPending: false }, 5 * 60_000, now)).toBeNull();
  });

  it("holds nothing that has never been attempted", () => {
    expect(heldUntil({ lastAttemptAt: null, repairPending: false }, HOUR, now)).toBeNull();
  });

  /**
   * A repair jumps the backoff, and only a repair (0025 §3, 0028). It is told
   * what went wrong and the recipe caps how many an item may buy, so it is
   * neither blind nor unbounded — and making it wait would leave the item it
   * exists for stuck an hour longer, which is the complaint rather than the fix.
   */
  it("holds nothing with a repair pending", () => {
    expect(heldUntil({ lastAttemptAt: at, repairPending: true }, HOUR, now)).toBeNull();
  });
});

/** What a person is shown. Minutes while it matters, hours while it does not. */
describe("inWords", () => {
  it("says a duration the way the recipe writes one", () => {
    expect(inWords(HOUR)).toBe("1h");
    expect(inWords(45 * 60_000)).toBe("45m");
    expect(inWords(90 * 60_000)).toBe("1h 30m");
    expect(inWords(30_000)).toBe("under a minute");
    expect(inWords(-1)).toBe("now");
  });

  /**
   * The board asks this about a card's age, where `48h` is correct and
   * unreadable — "five minutes and three days look identical" was the whole of
   * #79's first complaint.
   */
  it("says days once hours stop being readable", () => {
    expect(inWords(48 * HOUR)).toBe("2d");
    expect(inWords(51 * HOUR)).toBe("2d 3h");
    // The boundary belongs to hours, not to a zero-day.
    expect(inWords(23 * HOUR)).toBe("23h");
  });

  /** `Math.round` on the remainder turns 1h 59m 40s into "1h 60m". */
  it("never carries a remainder past its own unit", () => {
    expect(inWords(HOUR + 59 * 60_000 + 40_000)).toBe("1h 59m");
  });
});

/** The projection's own timestamp, so the test's window is the row's window. */
async function readAttempt(project: string): Promise<Date | null> {
  const c = new pg.Client({ connectionString: directDatabaseUrl() });
  await c.connect();
  try {
    const { rows } = await c.query<{ last_attempt_at: Date | null }>(
      "select last_attempt_at from task_view where project = $1",
      [project],
    );
    return rows[0]?.last_attempt_at ?? null;
  } finally {
    await c.end();
  }
}

async function drop(project: string): Promise<void> {
  const c = new pg.Client({ connectionString: directDatabaseUrl() });
  await c.connect();
  try {
    await c.query("delete from task_view where project = $1", [project]);
  } finally {
    await c.end();
  }
}
