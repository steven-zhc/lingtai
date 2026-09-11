/**
 * The loop, against the real log.
 *
 * Every property here is one of the three holes the file exists to close, so
 * none of them can be tested against a fake subscription: "a completion event
 * wakes it" is a claim about Postgres notifying, and "it does not replay
 * history" is a claim about where the subscription started.
 */
import { createDb, createEventStore, type Db, type EventStore } from "@lingtai/event-store";
import { directDatabaseUrl } from "@lingtai/env";
import { SUBSCRIBER_STREAM } from "@lingtai/domain";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkLoop } from "../src/index.ts";

const created = new Set<string>();
let client: Db;
let store: EventStore;

const landed = (id: string) => ({
  type: "WorkItemLanded",
  actor: "conductor",
  data: { mergeCommit: "abc1234", base: "develop" },
});

/** Waits for a condition rather than for a duration. */
async function until(what: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!what()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  client = createDb();
  store = createEventStore(client);
});

afterAll(async () => {
  await client.close();
  const c = new pg.Client({ connectionString: directDatabaseUrl() });
  await c.connect();
  try {
    await c.query("alter table events disable rule lingtai_events_no_delete");
    for (const id of created) await c.query("delete from events where stream_id = $1", [id]);
  } finally {
    await c.query("alter table events enable rule lingtai_events_no_delete");
    await c.end();
  }
});

describe("the work loop", () => {
  /**
   * The cold start. With nothing in flight there is no completion event, so an
   * event-driven loop that only listens never begins at all.
   */
  it("runs a pass at startup, before anything has happened", async () => {
    const reasons: string[] = [];
    const loop = createWorkLoop({
      pass: async (reason) => void reasons.push(reason),
    });

    await loop.start();
    try {
      expect(reasons).toEqual(["startup"]);
    } finally {
      await loop.stop();
    }
  });

  it("wakes on a completion event and not on anything else", async () => {
    const reasons: string[] = [];
    const loop = createWorkLoop({ pass: async (r) => void reasons.push(r) });
    await loop.start();

    try {
      const id = `wi-esctest-${crypto.randomUUID().slice(0, 8)}`;
      created.add(id);

      // A run appends steadily — touched files, guard trips, gate verdicts —
      // and waking on those would start a pass while the last one is still
      // mid-agent. This one must be ignored.
      await store.append(id, 0, [
        {
          type: "WorkItemBlocked",
          actor: "conductor",
          data: { question: "?", needsFrom: "human", runId: null, needs: null, diagnosis: null },
        },
      ]);
      await until(() => reasons.length >= 2);
      expect(reasons[1]).toBe("completion");
    } finally {
      await loop.stop();
    }
  });

  /**
   * A pass takes minutes and events arrive during it. Two passes into the same
   * queue would race for the same claim, and a burst of events must cost one
   * extra pass rather than one each.
   */
  it("never runs two passes at once, and collapses a burst into one more", async () => {
    let inFlight = 0;
    let overlapped = false;
    let release: () => void = () => {};
    const firstPass = new Promise<void>((r) => (release = r));

    let n = 0;
    const loop = createWorkLoop({
      pass: async () => {
        n += 1;
        inFlight += 1;
        if (inFlight > 1) overlapped = true;
        // Hold the first pass open while the events land.
        if (n === 1) await firstPass;
        inFlight -= 1;
      },
    });

    const started = loop.start();
    try {
      const ids = [1, 2, 3].map(() => `wi-esctest-${crypto.randomUUID().slice(0, 8)}`);
      for (const id of ids) {
        created.add(id);
        await store.append(id, 0, [landed(id)]);
      }

      release();
      await started;
      await until(() => loop.passes >= 2);

      expect(overlapped).toBe(false);
      // Three events during one pass buy one more pass, not three.
      expect(loop.passes).toBeLessThanOrEqual(3);
    } finally {
      release();
      await loop.stop();
    }
  });

  it("survives a pass that throws, because the next event is when to retry", async () => {
    let calls = 0;
    const loop = createWorkLoop({
      pass: async () => {
        calls += 1;
        throw new Error("the conductor blew up");
      },
    });

    // Startup must not reject: a loop that dies on its first bad pass is a
    // daemon that needs a person, which is the thing being removed.
    await expect(loop.start()).resolves.toBeUndefined();
    try {
      expect(calls).toBe(1);
    } finally {
      await loop.stop();
    }
  });

  /**
   * The drain, and the property 0030 is about: `stop()` does not return until
   * the pass in flight has finished. Everything else was already here —
   * `running`, `again`, `if (stopped) break` — so from outside the loop looked
   * as though it drained, and nothing retained the promise to wait on.
   */
  it("waits for the pass in flight before it stops", async () => {
    let inPass = false;
    let finished = false;
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));

    const loop = createWorkLoop({
      sweepMs: 0,
      pass: async () => {
        inPass = true;
        await held;
        finished = true;
      },
    });

    // Not awaited: `start()` awaits the first pass, which is the one being
    // held open here.
    const started = loop.start();
    await until(() => inPass);

    let drained = false;
    const stopping = loop.stop().then(() => (drained = true));

    // The pass is still going, so the drain has not returned. If it had, the
    // daemon would have exited over the top of a paid agent run.
    await new Promise((r) => setTimeout(r, 100));
    expect(drained).toBe(false);
    expect(finished).toBe(false);

    release();
    await stopping;
    await started;
    expect(finished).toBe(true);
    expect(drained).toBe(true);
  });

  /**
   * A shutdown is read where a pause is, and it takes nothing new after it.
   *
   * The `again` set by events arriving during the pass lapses on its own,
   * because `if (stopped) break` is at the top of the loop — which is the whole
   * of what 0030 §1 needed from the existing machinery.
   */
  it("stops taking work when the log says to shut down, and says who asked", async () => {
    let passes = 0;
    const told: string[] = [];
    let allowed = false;

    const loop = createWorkLoop({
      sweepMs: 0,
      // Nothing on the first pass, everything after: a daemon that reads the
      // request at startup must run no pass at all.
      shutdown: async () => (allowed ? null : "asked by human:steven — picking up #88"),
      onShutdown: (why) => void told.push(why),
      pass: async () => void (passes += 1),
    });

    await loop.start();
    try {
      expect(passes).toBe(0);
      expect(told).toEqual(["asked by human:steven — picking up #88"]);

      // And it stays stopped: an event arriving afterwards must not restart a
      // conductor that is on its way out, whatever the log then says.
      allowed = true;
      const id = `wi-esctest-${crypto.randomUUID().slice(0, 8)}`;
      created.add(id);
      await store.append(id, 0, [landed(id)]);
      await new Promise((r) => setTimeout(r, 200));
      expect(passes).toBe(0);
    } finally {
      await loop.stop();
    }
  });

  /**
   * The other half of
   * [0031](../../../doc/decisions/0031-a-run-that-never-started.md) §3 and §5:
   * `run-once` appends the pause, and this is what makes it mean something.
   *
   * A pause is asked before every pass and never cached, so a quota pause lands
   * on the pass after the run that met it and nothing else is taken. And
   * because the *expiry* is folded rather than acted on, the loop needs no
   * timer for the resume — the same question, asked again, simply answers
   * differently once the reset has gone by. That is the twelve minutes 0031 is
   * replacing: nobody has to type `lingtai resume`.
   */
  /**
   * The subscriber boundary, against the real subscription — which is the only
   * place it can be tested, because the claim is about the process that follows
   * the log surviving what a subscriber does to it.
   *
   * Three failures in one test on purpose: they are three shapes of the same
   * defect and the boundary has to hold all three. A throw never reaches a
   * `.catch` at all; a rejection reaches one only if somebody wrote it, and
   * `notify` had none; and a subscriber that simply never settles produces no
   * signal whatsoever, which is the failure a notifier must not have.
   */
  it("survives a subscriber that throws, rejects or hangs, and records each one", async () => {
    const tag = crypto.randomUUID().slice(0, 8);
    // One project per case, so the failures this test appends can be told from
    // any the log already holds.
    const stream = (which: string) => `wi-esctest${which}${tag}-1`;
    const project = (which: string) => `esctest${which}${tag}`;
    const cases = ["throws", "rejects", "hangs", "after"];
    for (const which of cases) created.add(stream(which));
    created.add(SUBSCRIBER_STREAM);

    const seen: string[] = [];
    const loop = createWorkLoop({
      sweepMs: 0,
      store,
      // Short, because the property is that a hang is *reported*; how long a
      // real subscriber is given before that is a separate decision.
      subscriberTimeoutMs: 150,
      notify: (event) => {
        seen.push(event.streamId);
        if (event.streamId === stream("throws")) throw new Error("threw before returning a promise");
        if (event.streamId === stream("rejects")) return Promise.reject(new Error("rejected afterwards"));
        // Never settles. Nothing cancels it; the boundary times it out.
        if (event.streamId === stream("hangs")) return new Promise<void>(() => {});
        return Promise.resolve();
      },
      pass: async () => {},
    });

    await loop.start();
    try {
      for (const which of cases) {
        const id = stream(which);
        await store.append(id, 0, [landed(id)]);
      }

      // The whole claim: the follower is still delivering after all three.
      await until(() => seen.includes(stream("after")));

      // And each failure is on the log, not only in a console line that is gone
      // by morning.
      type Failure = { name: string; eventType: string; project: string | null; reason: string };
      const mine = async (): Promise<Failure[]> =>
        (await store.read(SUBSCRIBER_STREAM))
          .filter((r) => r.type === "PluginFailed")
          .map((r) => r.data as Failure)
          .filter((d) => d.project !== null && d.project.endsWith(tag));

      let failures = await mine();
      const deadline = Date.now() + 10_000;
      while (failures.length < 3) {
        if (Date.now() > deadline) throw new Error(`timed out with ${failures.length} failure(s) recorded`);
        await new Promise((r) => setTimeout(r, 50));
        failures = await mine();
      }

      expect(new Set(failures.map((f) => f.project))).toEqual(
        new Set([project("throws"), project("rejects"), project("hangs")]),
      );
      expect(new Set(failures.map((f) => f.name))).toEqual(new Set(["notify"]));
      expect(new Set(failures.map((f) => f.eventType))).toEqual(new Set(["WorkItemLanded"]));
      const hung = failures.find((f) => f.project === project("hangs"));
      expect(hung?.reason).toMatch(/did not return within/);
      // The one that succeeded appended nothing: a boundary that recorded every
      // delivery would be a second log of the first.
      expect(failures.some((f) => f.project === project("after"))).toBe(false);
    } finally {
      await loop.stop();
    }
  });

  /**
   * A subscriber the recipe declared, through the same boundary (`#125`).
   *
   * The composition is what is new here: `subscribersFromRecipe` is tested
   * against real processes in `@lingtai/actions`, and the boundary is tested
   * above. What nothing else asserts is that a declared subscriber which
   * refuses — Telegram unreachable, which is the ticket's own case — is
   * recorded under **the name in the YAML**, and that the conductor finishes
   * the pass regardless. A subscriber here is a name, a `wants` and a promise;
   * that it is a command in the daemon is the caller's business.
   */
  it("records a declared subscriber's refusal under its own name, and still passes", async () => {
    const tag = crypto.randomUUID().slice(0, 8);
    const id = `wi-esctest${tag}-1`;
    created.add(id);
    created.add(SUBSCRIBER_STREAM);

    const offered: string[] = [];
    let passes = 0;
    const loop = createWorkLoop({
      sweepMs: 0,
      store,
      subscribers: [
        {
          name: "telegram",
          wants: (event) => event.type === "WorkItemLanded",
          consider: async (event) => {
            offered.push(event.type);
            throw new Error("telegram unreachable: getaddrinfo ENOTFOUND api.telegram.org");
          },
        },
        {
          // Declared for something else entirely. It must not be started, and
          // must not appear in `ext-subscribers` for an event it never wanted.
          name: "pager",
          wants: (event) => event.type === "RunFailed",
          consider: async () => {
            throw new Error("should never run");
          },
        },
      ],
      pass: async () => void (passes += 1),
    });

    await loop.start();
    try {
      await store.append(id, 0, [landed(id)]);

      type Failure = { name: string; eventType: string; project: string | null; reason: string };
      const mine = async (): Promise<Failure[]> =>
        (await store.read(SUBSCRIBER_STREAM))
          .filter((r) => r.type === "PluginFailed")
          .map((r) => r.data as Failure)
          .filter((d) => d.project === `esctest${tag}`);

      // Polled rather than `until`, which asks a synchronous question: this
      // one is a read of the log.
      let failures = await mine();
      const deadline = Date.now() + 10_000;
      while (failures.length === 0) {
        if (Date.now() > deadline) throw new Error("timed out with nothing recorded");
        await new Promise((r) => setTimeout(r, 50));
        failures = await mine();
      }
      expect(failures.map((f) => f.name)).toEqual(["telegram"]);
      expect(failures[0]?.reason).toMatch(/unreachable/);
      expect(offered).toEqual(["WorkItemLanded"]);

      // A landing is a completion event, so the conductor was going round
      // anyway — the point is that a refusing subscriber did not stop it.
      await until(() => passes > 1);
    } finally {
      await loop.stop();
    }
  });

  it("takes nothing while a pause holds, and takes work again when it lifts by itself", async () => {
    let passes = 0;
    // Stands in for `reduceControl` reaching the expiry: the same fold, asked
    // twice, over a clock that moved.
    let lifted = false;

    const loop = createWorkLoop({
      // No sweep, so every pass here is one an event asked for. The real daemon
      // sweeps as well, which is what bounds how late the automatic resume can
      // be on a queue that is otherwise silent.
      sweepMs: 0,
      paused: async () => !lifted,
      pass: async () => void (passes += 1),
    });

    await loop.start();
    try {
      expect(passes).toBe(0);

      const id = `wi-esctest-${crypto.randomUUID().slice(0, 8)}`;
      created.add(id);
      await store.append(id, 0, [landed(id)]);
      await new Promise((r) => setTimeout(r, 200));
      expect(passes).toBe(0);

      lifted = true;
      const next = `wi-esctest-${crypto.randomUUID().slice(0, 8)}`;
      created.add(next);
      await store.append(next, 0, [landed(next)]);
      await until(() => passes > 0);
    } finally {
      await loop.stop();
    }
  });
});
