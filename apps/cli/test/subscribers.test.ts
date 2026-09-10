/**
 * Who is told, and what it costs to ask.
 *
 * The first half needs nothing: the dispatcher takes its projects and their
 * recipes as callbacks, so which subscribers an event is due is a function of
 * three inputs and can be asked for free.
 *
 * The second half needs the log, and could not be written any other way. Its
 * claim is that **the process that follows the log survives an extension being
 * killed mid-event, and the failure ends up on the log rather than in a console
 * line** — which is a claim about a real subscription, a real child process and
 * a real append. A fake of any of the three would be a test of the fake.
 */
import { createDb, createEventStore, type Db, type EventStore } from "@lingtai/event-store";
import { directDatabaseUrl } from "@lingtai/env";
import { SUBSCRIBER_STREAM, type Envelope, type ProjectState } from "@lingtai/domain";
import { createWorkLoop } from "@lingtai/daemon";
import type { Subscriber } from "@lingtai/recipe";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSubscriberDispatch } from "../src/subscribers.ts";

const created = new Set<string>();
let client: Db;
let store: EventStore;
let dir: string;

const registered = (name: string): ProjectState =>
  ({ project: name, owner: "acme", base: "main" }) as ProjectState;

const spec = (over: Partial<Subscriber>): Subscriber => ({
  name: "notify",
  on: ["WorkItemLanded"],
  run: "true",
  timeout: "20s",
  env: [],
  ...over,
});

const event = (over: Partial<Envelope> = {}): Envelope => ({
  seq: 1n,
  streamId: "wi-acme-7",
  version: 1,
  type: "WorkItemLanded",
  schemaVer: 1,
  data: { mergeCommit: "abc1234", base: "main" },
  actor: "conductor",
  causation: null,
  at: new Date(),
  ...over,
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
  dir = mkdtempSync(join(tmpdir(), "lingtai-subs-"));
});

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
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

describe("which subscribers an event is due", () => {
  const dispatch = (subscribers: readonly Subscriber[], names = ["acme"]) =>
    createSubscriberDispatch({
      projects: async () => names.map(registered),
      subscribersOf: async () => subscribers,
      boardUrl: "http://board",
      store,
      run: async () => {},
    });

  it("hands the event to what the recipe declared, by the name it gave it", async () => {
    const due = await dispatch([spec({ name: "telegram" })])(event());
    expect(due.map((d) => d.name)).toEqual(["telegram"]);
  });

  /**
   * The cheap first question, and the reason a run appending two hundred events
   * does not cost two hundred recipe reads: a type nothing declared is a set
   * lookup and nothing else.
   */
  it("says nothing is due for a type no project declared", async () => {
    expect(await dispatch([spec({ on: ["WorkItemLanded"] })])(event({ type: "RunTouchedFile" }))).toEqual([]);
  });

  it("declaring the type is the subscription — a second one is not consulted", async () => {
    const due = await dispatch([
      spec({ name: "landed", on: ["WorkItemLanded"] }),
      spec({ name: "blocked", on: ["WorkItemBlocked"] }),
    ])(event());
    expect(due.map((d) => d.name)).toEqual(["landed"]);
  });

  /**
   * An `IntegrationRefused` is on `int-<project>-<base>`, and neither the
   * project's name nor the base's says where it ends — so the registered names
   * decide, longest first.
   */
  it("finds the project of an integration lane, even when a longer name shares its prefix", async () => {
    const due = await dispatch(
      [spec({ name: "telegram", on: ["IntegrationRefused"] })],
      ["acme", "acme-web"],
    )(event({ streamId: "int-acme-web-main", type: "IntegrationRefused" }));
    expect(due.map((d) => d.name)).toEqual(["telegram"]);
  });

  /**
   * A question from a running agent is on `run-<uuid>`, which names neither a
   * project nor a ticket. The dispatcher learns the pair from the `RunStarted`
   * it is handed on the way past — this is the whole of why the notification
   * has a number and a link on it.
   */
  it("remembers which work item a run is of, and gives the extension its ticket", async () => {
    const seen: unknown[] = [];
    const subscribers = createSubscriberDispatch({
      projects: async () => [registered("acme")],
      subscribersOf: async () => [spec({ on: ["RunStarted", "RunAwaitingInput"] })],
      boardUrl: "http://board",
      store,
      run: async (_spec, _project, payload) => void seen.push(payload),
    });

    await subscribers(
      event({ streamId: "run-8f2c", type: "RunStarted", data: { workItemId: "wi-acme-7" } }),
    );
    const due = await subscribers(
      event({ streamId: "run-8f2c", type: "RunAwaitingInput", data: { prompt: "Which base?" } }),
    );
    await Promise.all(due.map((d) => d.deliver()));

    const payload = seen[0] as { ticket: { issue: string }; board: { task: string } };
    expect(payload.ticket.issue).toBe("7");
    expect(payload.board.task).toBe("http://board/task/wi-acme-7");
  });

  /**
   * A pause, a shutdown, a question: there is no recipe to declare anything
   * about them, so nothing is due. A real narrowing from the notifier this
   * replaces, which subscribed with `project: "*"` and fired on events it could
   * name no task for.
   */
  it("has nothing to say about an event that belongs to no repository", async () => {
    const due = await dispatch([spec({ on: ["ConductorPaused"] })])(
      event({ streamId: "ctl-conductor", type: "ConductorPaused" }),
    );
    expect(due).toEqual([]);
  });

  /**
   * An outage must not be a quiet week. A minute of GitHub being unreachable
   * would otherwise be a minute in which a blocked ticket notifies nobody —
   * the failure a notifier must not have, bought by an outage rather than a
   * bug. Subscribers stop only when a recipe that was actually read says so.
   */
  it("keeps what a project last declared when its recipe cannot be read", async () => {
    let attempt = 0;
    const lines: string[] = [];
    const subscribers = createSubscriberDispatch({
      projects: async () => [registered("acme")],
      subscribersOf: async () => {
        attempt += 1;
        if (attempt > 1) throw new Error("GitHub is unreachable");
        return [spec({ name: "telegram" })];
      },
      // Every event refreshes, so the second one is the outage.
      ttlMs: 0,
      boardUrl: "http://board",
      store,
      run: async () => {},
      log: (line) => lines.push(line),
    });

    expect((await subscribers(event())).map((d) => d.name)).toEqual(["telegram"]);
    expect((await subscribers(event())).map((d) => d.name)).toEqual(["telegram"]);
    expect(lines.join("\n")).toContain("GitHub is unreachable");
  });

  /**
   * Refused before the command is started, for the reason `env.required`
   * refuses a project before anything is claimed: an extension started without
   * its token is an HTTP 401 two minutes later, about a variable nobody thought
   * was missing.
   */
  it("will not start an extension whose declared credentials are not set", async () => {
    const subscribers = createSubscriberDispatch({
      projects: async () => [registered("acme")],
      subscribersOf: async () => [
        spec({ name: "telegram", env: ["MADE_UP_TOKEN_FOR_THIS_TEST"], run: `touch ${join(dir, "never")}` }),
      ],
      boardUrl: "http://board",
      cwd: dir,
      store,
    });

    const [delivery] = await subscribers(event());
    await expect(delivery?.deliver()).rejects.toThrow(/MADE_UP_TOKEN_FOR_THIS_TEST/);
    expect(existsSync(join(dir, "never"))).toBe(false);
  });
});

/**
 * The claim `#126` ends on, against the real log: **killing an extension
 * mid-event does not stop the log being followed, and leaves a `PluginFailed`
 * in the log rather than a console line.**
 *
 * Two subscribers on one event, because the boundary has to hold one without
 * costing the other: one writes what it was given to a file, the other kills
 * itself before it can. Then a second event, to show the follower is still
 * following.
 */
describe("a subscriber that is killed mid-event", () => {
  it("is recorded on the log, and the loop goes on delivering", async () => {
    const tag = crypto.randomUUID().slice(0, 8);
    const project = `esctest${tag}`;
    const first = `wi-${project}-1`;
    const second = `wi-${project}-2`;
    created.add(first);
    created.add(second);
    created.add(SUBSCRIBER_STREAM);

    const wrote = join(dir, `${tag}.json`);
    const after = join(dir, `${tag}.after`);

    const loop = createWorkLoop({
      sweepMs: 0,
      store,
      subscriberTimeoutMs: 30_000,
      subscribers: createSubscriberDispatch({
        projects: async () => [registered(project)],
        subscribersOf: async () => [
          spec({ name: "writes", run: `cat > "${wrote}"` }),
          spec({ name: "dies", run: "kill -9 $$" }),
          spec({ name: "later", on: ["WorkItemBlocked"], run: `touch "${after}"` }),
        ],
        boardUrl: "http://board",
        cwd: dir,
        store,
      }),
      pass: async () => {},
    });

    await loop.start();
    try {
      await store.append(first, 0, [
        { type: "WorkItemLanded", actor: "conductor", data: { mergeCommit: "abc1234", base: "main" } },
      ]);
      await until(() => existsSync(wrote));

      // The one that ran got the event, whole, on stdin.
      const payload = JSON.parse(readFileSync(wrote, "utf8")) as {
        event: { type: string };
        ticket: { issue: string };
      };
      expect(payload.event.type).toBe("WorkItemLanded");
      expect(payload.ticket.issue).toBe("1");

      // The one that was killed is on the log, under its own name — not in a
      // console line that is gone by morning (`#120`).
      type Failure = { name: string; eventType: string; project: string | null; reason: string };
      const mine = async (): Promise<Failure[]> =>
        (await store.read(SUBSCRIBER_STREAM))
          .filter((r) => r.type === "PluginFailed")
          .map((r) => r.data as Failure)
          .filter((d) => d.project === project);
      let failures = await mine();
      const deadline = Date.now() + 20_000;
      while (failures.length === 0) {
        if (Date.now() > deadline) throw new Error("no PluginFailed was recorded");
        await new Promise((r) => setTimeout(r, 100));
        failures = await mine();
      }
      expect(failures.map((f) => f.name)).toEqual(["dies"]);
      expect(failures[0]?.eventType).toBe("WorkItemLanded");

      // And the follower is still following, which is the whole point of the
      // boundary: a second event reaches a third subscriber afterwards.
      await store.append(second, 0, [
        {
          type: "WorkItemBlocked",
          actor: "conductor",
          data: { question: "Which base?", needsFrom: "human", runId: null, needs: "judgement", diagnosis: null },
        },
      ]);
      await until(() => existsSync(after));
    } finally {
      await loop.stop();
    }
  });
});
