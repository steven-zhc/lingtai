/**
 * What replaced the outbox, against the real store and a fake GitHub.
 *
 * The port exists so that this file needs no network, and the two properties
 * worth asserting are the two the outbox was built to give:
 *
 * **A failure is recorded rather than retried.** `IssueUpdateFailed` lands, and
 * `tellGitHub` still returns normally — a label that did not stick must not
 * turn a merge that did into a failed run.
 *
 * **A whole-set label write keeps everybody else's labels.** The first outbox
 * drain stripped `enhancement` off three admin issues — the label their recipe
 * selects on — so Lingtai deleted its own queue's selection criteria. That is
 * the regression this case exists for.
 */
import { directDatabaseUrl } from "@lingtai/env";
import { createDb, createEventStore, type Db, type EventStore } from "@lingtai/store";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type IssueChannel, tellGitHub } from "../src/tell.ts";

const PROJECT = `esctest${crypto.randomUUID().slice(0, 6)}`;
const created = new Set<string>();
let client: Db;
let store: EventStore;

const wi = (n: number) => {
  const id = `wi-${PROJECT}-${n}`;
  created.add(id);
  return id;
};

/** A GitHub that records what it was asked to do, and fails when told to. */
function fakeGitHub(opts: { labels?: string[]; fail?: boolean } = {}) {
  const calls: string[] = [];
  let set: readonly string[] = [];
  const boom = () => {
    throw new Error("422 unprocessable");
  };
  const channel: IssueChannel = {
    async getIssue() {
      calls.push("getIssue");
      return { labels: opts.labels ?? [] };
    },
    async comment(_issue, body) {
      calls.push(`comment:${body.slice(0, 12)}`);
      if (opts.fail) boom();
      return { id: 909 };
    },
    async setLabels(_issue, labels) {
      calls.push("setLabels");
      if (opts.fail) boom();
      set = labels;
    },
    async closeIssue() {
      calls.push("closeIssue");
      if (opts.fail) boom();
    },
  };
  return { channel, calls, get set() { return set; } };
}

const last = async (id: string) => {
  const events = await store.read(id);
  return events[events.length - 1];
};

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
    for (const id of created) await c.query("delete from events where stream_id = $1", [id]);
  } finally {
    await c.query("alter table events enable rule lingtai_events_no_delete");
    await c.end();
  }
});

describe("tellGitHub", () => {
  it("keeps labels that are somebody else's, and records what it set", async () => {
    const id = wi(1);
    const gh = fakeGitHub({ labels: ["enhancement", "lingtai:waiting"] });
    await tellGitHub({ store, github: gh.channel, workItemId: id, change: { kind: "labels", labels: ["lingtai:working"] } });

    expect(gh.set, "the foreign label survives a whole-set write").toContain("enhancement");
    expect(gh.set).toContain("lingtai:working");
    expect(gh.set, "and our stale one does not").not.toContain("lingtai:waiting");

    const e = await last(id);
    expect(e?.type).toBe("IssueUpdated");
    expect(e?.data).toMatchObject({ project: PROJECT, issue: "1", change: "labels", detail: "lingtai:working" });
  });

  it("records a comment by its id", async () => {
    const id = wi(2);
    const gh = fakeGitHub();
    await tellGitHub({ store, github: gh.channel, workItemId: id, change: { kind: "comment", body: "**Lingtai is waiting on you.**" } });
    const e = await last(id);
    expect(e?.type).toBe("IssueUpdated");
    expect(e?.data).toMatchObject({ change: "comment", detail: "909" });
  });

  it("records a close", async () => {
    const id = wi(3);
    const gh = fakeGitHub();
    await tellGitHub({ store, github: gh.channel, workItemId: id, change: { kind: "closed" } });
    expect(gh.calls).toContain("closeIssue");
    expect((await last(id))?.data).toMatchObject({ change: "closed" });
  });

  it("writes the failure down and does not throw", async () => {
    const id = wi(4);
    const gh = fakeGitHub({ fail: true });
    await expect(
      tellGitHub({ store, github: gh.channel, workItemId: id, change: { kind: "closed" } }),
    ).resolves.toBeUndefined();

    const e = await last(id);
    expect(e?.type).toBe("IssueUpdateFailed");
    expect(e?.data).toMatchObject({ change: "closed", error: "422 unprocessable" });
  });

  it("does nothing at all for a stream id that is not a work item", async () => {
    const gh = fakeGitHub();
    await expect(
      tellGitHub({ store, github: gh.channel, workItemId: "nonsense", change: { kind: "closed" } }),
    ).resolves.toBeUndefined();
    expect(gh.calls, "no call was made").toHaveLength(0);
  });
});
