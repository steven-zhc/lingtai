/**
 * The beacon, against the real row it writes.
 *
 * `#144`'s failure was not in the arithmetic — three missed beats is a sound
 * rule — but in there being a stretch of the daemon's life during which nothing
 * beat. Startup wrote `starting` once by hand and then spent fifteen seconds
 * reading recipes over the network and reconciling GitHub labels, and
 * `lingtai doctor` read that untouched row and said `not running` about a
 * process it was printing the lock of on the next line.
 *
 * So the first test here is a slow startup, in real time, and it is slow on
 * purpose: the claim is *however long the slow work takes*, and a fake clock
 * would assert the timer was configured rather than that it fires. It holds the
 * beacon for longer than `STALE_AFTER_MS` without ever telling it startup
 * finished, and asks the row the question `doctor` and the board's chips ask —
 * `lastBeat`, which is now the one place either of them asks it.
 */
import { directDatabaseUrl } from "@lingtai/env";
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import {
  HEARTBEAT_MS,
  STALE_AFTER_MS,
  createStatusTable,
  lastBeat,
  readStatus,
  startBeacon,
} from "../src/control.ts";

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `daemon_status` is one row for the whole installation, so a test that leaves
 * one behind is a test that tells the next package's `lingtai doctor` a daemon
 * is up. Nothing else in the suite writes it, so removing it restores exactly
 * the state these tests found.
 */
afterAll(async () => {
  const client = new pg.Client({ connectionString: directDatabaseUrl() });
  await client.connect();
  try {
    await client.query("delete from daemon_status where id = 1");
  } catch {
    // No table means no row to clear, which is the state we wanted.
  } finally {
    await client.end();
  }
});

describe("the beacon", () => {
  it("keeps the row fresh through a startup slower than three missed beats", async () => {
    await createStatusTable();
    const beacon = startBeacon("starting");

    try {
      // Standing in for the slow half of startup: a recipe read per project and
      // a reconcile that writes labels. Nothing says `up`, because in the run
      // that produced #144 nothing had yet.
      await wait(STALE_AFTER_MS + 2_000);

      const status = await readStatus();
      expect(status).not.toBeNull();
      const beat = lastBeat(status!);

      // The row doctor reads. `up` is the boolean its `not running` sentence
      // hangs off, and `starting` is the word that says which kind of up.
      expect(beat.up).toBe(true);
      expect(beat.state).toBe("starting");
      // Not merely inside the threshold: within a beat of now, which is the
      // difference between a timer that ran and one that ran once.
      expect(beat.ageMs).toBeLessThan(HEARTBEAT_MS * 2);
    } finally {
      await beacon.stop();
    }
  }, 60_000);

  it("changes the word without missing a beat, and the last word wins", async () => {
    await createStatusTable();
    // Faster than production only so that several beats land inside a test;
    // what is being asserted is the ordering, which is not a function of the
    // period.
    const beacon = startBeacon("starting", { every: 50 });

    try {
      await beacon.say("up");
      expect(beacon.state).toBe("up");
      expect((await readStatus())?.state).toBe("up");

      await beacon.say("draining");
      expect((await readStatus())?.state).toBe("draining");

      // Two beats' worth of ticks, each carrying the word the beacon holds
      // now. The row must not fall back to an earlier one: they are UPSERTs of
      // a single row, so an out-of-order write is a lie and not a delay.
      await wait(200);
      expect((await readStatus())?.state).toBe("draining");
    } finally {
      await beacon.stop();
    }
  });

  it("says a last word and then nothing at all", async () => {
    await createStatusTable();
    const beacon = startBeacon("up", { every: 50 });
    await beacon.stop("stopping");

    const stopped = await readStatus();
    expect(stopped?.state).toBe("stopping");

    // The timer is off with the last word, so the row a stopped daemon leaves
    // goes stale — which is how `doctor` and the board report it, and it cannot
    // if something is still beating.
    await wait(200);
    const later = await readStatus();
    expect(later?.lastSeenAt.getTime()).toBe(stopped?.lastSeenAt.getTime());
    expect(later?.state).toBe("stopping");

    // Idempotent, and a word after the stop is not written: the drain calls
    // `stop` and so does a second Ctrl+C on its way past.
    await beacon.say("up");
    await beacon.stop("stopping");
    expect((await readStatus())?.state).toBe("stopping");
  });
});

describe("what the beacon's row means", () => {
  const row = (over: Partial<{ state: string; lastSeenAt: Date }>) => ({
    pid: 28982,
    host: "local",
    startedAt: new Date(0),
    lastSeenAt: new Date(0),
    state: "up",
    currentRunId: null,
    codeSha: null,
    codeDirty: false,
    ...over,
  });

  it("calls a daemon down only on the age, whatever word it left behind", () => {
    const now = 1_000_000;
    // The exemption not taken: a beacon that says `starting` and stopped
    // beating is a daemon that died on the way up, and reading the word as
    // permission to call it alive would make that wrong answer permanent
    // instead of twelve seconds long.
    const died = lastBeat(row({ state: "starting", lastSeenAt: new Date(now - STALE_AFTER_MS - 1) }), now);
    expect(died.up).toBe(false);
    // Still carried, because it is what doctor says instead of guessing: this
    // one never got as far as taking work.
    expect(died.state).toBe("starting");
  });

  it("keeps a beacon inside the threshold up, and reports its age", () => {
    const now = 1_000_000;
    const beating = lastBeat(row({ state: "starting", lastSeenAt: new Date(now - 2_000) }), now);
    expect(beating.up).toBe(true);
    expect(beating.ageMs).toBe(2_000);
  });
});
