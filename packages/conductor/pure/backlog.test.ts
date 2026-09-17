/**
 * Deciding a backlog entry, with the store and the log faked (`#137`).
 *
 * The properties: an accepted entry opens exactly one ticket through the
 * store, carrying the claim, the failure scenario and its origin; nothing is
 * opened without a person, or under a kind the recipe does not list; a
 * decision already on the log is not asked again; and every failure after the
 * decision — however slow, however interleaved — is answered by opening again,
 * and converges on one issue the log names.
 */
import type { Envelope, ToAppend } from "@lingtai/domain";
import { backlogStream } from "@lingtai/domain";
import { ConcurrencyError, type EventStore } from "@lingtai/event-store";
import type { GitHubClient, Issue } from "@lingtai/github";
import type { BacklogEntry } from "@lingtai/projector";
import { describe, expect, it } from "vitest";
import { acceptFinding, declineFinding, proposalFor } from "../src/backlog.ts";
import { githubTicketStore, keyMarker, type TicketStore } from "../src/ticket-store.ts";

const entry: BacklogEntry = {
  key: "0123456789ab",
  project: "lingtai",
  issue: "135",
  taskId: "wi-lingtai-135",
  runId: "run-abc",
  gate: "proposed",
  action: "review",
  onSha: "f".repeat(40),
  file: "packages/a.ts",
  line: 12,
  severity: "minor",
  claim: "the fallback swallows the error",
  failureScenario: "when the read fails, the caller sees an empty list and no message",
  raisedSeq: "4410",
  raisedAt: new Date(0),
  status: "open",
  decidedBy: null,
  decidedAt: null,
  kind: null,
  proposedRef: null,
  proposedUrl: null,
  reason: null,
};

/**
 * A log that keeps what is appended and enforces the expected version, as the
 * real store's `UNIQUE (stream_id, version)` does. `failAppend` throws a
 * non-concurrency error for the event type it names, until `heal`.
 */
function fakeLog(options: { failAppend?: string } = {}) {
  const streams = new Map<string, Envelope[]>();
  let seq = 100n;
  let failAppend = options.failAppend;
  const store = {
    async read(stream: string) {
      return [...(streams.get(stream) ?? [])];
    },
    async append(stream: string, version: number, events: readonly ToAppend[]) {
      if (events.some((e) => e.type === failAppend)) throw new Error("Connection terminated");
      const list = streams.get(stream) ?? [];
      if (list.length !== version) throw new ConcurrencyError(stream, version, [version + 1]);
      for (const e of events) {
        list.push({
          seq: seq++, streamId: stream, version: list.length + 1, type: e.type, schemaVer: 1,
          data: e.data, actor: e.actor, causation: null, at: new Date(),
        });
      }
      streams.set(stream, list);
      return [];
    },
  } as unknown as EventStore;
  return {
    store,
    typesOn: (stream: string) => (streams.get(stream) ?? []).map((e) => e.type),
    dataOn: (stream: string) => (streams.get(stream) ?? []).map((e) => e.data),
    heal: () => {
      failAppend = undefined;
    },
  };
}

/**
 * GitHub, as far as the ticket store touches it. `beforeCreate` runs inside a
 * create before the issue exists — a POST that is still in flight — and
 * `afterCreate` after it exists and before the response arrives.
 */
function fakeGitHub(hooks: { beforeCreate?: () => Promise<void>; afterCreate?: () => Promise<void> } = {}) {
  const issues: Issue[] = [];
  const said: string[] = [];
  let { beforeCreate, afterCreate } = hooks;
  const client: Pick<GitHubClient, "createIssue" | "listIssuesSince" | "comment" | "closeIssue"> = {
    async createIssue(input) {
      const before = beforeCreate;
      beforeCreate = undefined;
      if (before) await before();
      const issue: Issue = {
        number: 212 + issues.length, title: input.title, body: input.body,
        labels: input.labels.map((name) => ({ name, color: null })), state: "open",
        url: `https://example/${212 + issues.length}`, dependencies: null, assignees: [],
      };
      issues.push(issue);
      const after = afterCreate;
      afterCreate = undefined;
      if (after) await after();
      return issue;
    },
    async listIssuesSince() {
      return [...issues];
    },
    async comment(n, body) {
      said.push(`#${n}: ${body}`);
      return { id: 1 };
    },
    async closeIssue(n, reason) {
      said.push(`close #${n} ${reason}`);
      const i = issues.find((x) => x.number === n);
      if (i) i.state = "closed";
    },
  };
  return { client, issues, said, open: () => issues.filter((i) => i.state === "open") };
}

const found = async () => entry;
const stream = backlogStream("lingtai", entry.key);
const KINDS = ["bug", "tech-debt", "feature"];

const accept = (log: ReturnType<typeof fakeLog>, tickets: TicketStore, over: Record<string, unknown> = {}) =>
  acceptFinding({
    project: "lingtai", key: entry.key, by: "human:steven", kind: "bug", kinds: KINDS,
    labels: ["agent:hold"], tickets, events: log.store, entry: found, ...over,
  });
const decline = (log: ReturnType<typeof fakeLog>, over: Record<string, unknown> = {}) =>
  declineFinding({ project: "lingtai", key: entry.key, by: "human:other", reason: "no", events: log.store, entry: found, ...over });

describe("proposalFor", () => {
  it("carries the claim, the failure scenario, and the run and gate it came from", () => {
    const since = new Date();
    const t = proposalFor(entry, { kind: "tech-debt", labels: ["agent:hold"] }, since);
    expect(t).toMatchObject({ key: entry.key, since, title: "the fallback swallows the error", kind: "tech-debt", labels: ["agent:hold"] });
    for (const needle of [
      "packages/a.ts:12", entry.claim, entry.failureScenario, "#135", "run-abc",
      "`proposed`, action `review`", "0123456789ab", "## Done when",
    ]) {
      expect(t.body).toContain(needle);
    }
  });
});

describe("githubTicketStore", () => {
  const ticket = { key: "k1", since: new Date(), title: "t", body: "b", kind: "bug", labels: ["agent:hold", "bug"] };

  it("writes the kind and the holds as labels and the key into the body, and answers with the issue number", async () => {
    const gh = fakeGitHub();
    const ref = await githubTicketStore(gh.client).propose(ticket);
    expect(ref).toEqual({ externalRef: "212", url: "https://example/212", created: true });
    expect(gh.issues[0]!.labels.map((l) => l.name)).toEqual(["bug", "agent:hold"]);
    expect(gh.issues[0]!.body).toContain(keyMarker("k1"));
  });

  it("is idempotent on the key: asked again, it answers with the issue it has", async () => {
    const gh = fakeGitHub();
    const store = githubTicketStore(gh.client);
    await store.propose(ticket);
    expect(await store.propose(ticket)).toEqual({ externalRef: "212", url: "https://example/212", created: false });
    expect(gh.issues).toHaveLength(1);
    // A different key is a different ticket.
    await store.propose({ ...ticket, key: "k2" });
    expect(gh.issues).toHaveLength(2);
  });

  it("converges when two proposes race: the newer issue is closed as a duplicate of the older", async () => {
    const holder: { store?: TicketStore } = {};
    // The second propose runs entirely while the first's POST is in flight.
    const gh = fakeGitHub({ beforeCreate: async () => void (await holder.store!.propose(ticket)) });
    holder.store = githubTicketStore(gh.client);
    const ref = await holder.store.propose(ticket);
    expect(gh.issues).toHaveLength(2);
    expect(gh.open().map((i) => i.number)).toEqual([212]);
    expect(ref).toMatchObject({ externalRef: "212", created: false });
    expect(gh.said).toEqual([expect.stringContaining("#213: Duplicate of #212"), "close #213 not_planned"]);
  });
});

describe("acceptFinding", () => {
  it("records the decision, then opens one ticket through the store, then records which", async () => {
    const log = fakeLog();
    const gh = fakeGitHub();
    const r = await accept(log, githubTicketStore(gh.client), { kind: "tech-debt" });
    expect(r).toMatchObject({ ok: true, externalRef: "212" });
    expect(gh.issues).toHaveLength(1);
    expect(log.typesOn(stream)).toEqual(["FindingAccepted", "FindingProposed"]);
    expect(log.dataOn(stream)).toEqual([
      { project: "lingtai", key: entry.key, by: "human:steven", kind: "tech-debt", labels: ["agent:hold"] },
      { project: "lingtai", key: entry.key, by: "human:steven", externalRef: "212", url: "https://example/212" },
    ]);
  });

  it("opens nothing without a person", async () => {
    const log = fakeLog();
    const gh = fakeGitHub();
    const r = await accept(log, githubTicketStore(gh.client), { by: "conductor" });
    expect(r.ok).toBe(false);
    expect(gh.issues).toEqual([]);
    expect(log.typesOn(stream)).toEqual([]);
  });

  it("refuses a kind the recipe's source.kinds does not list, and no kind at all, and opens nothing", async () => {
    for (const kind of ["techdebt", "enhancement", "", undefined]) {
      const log = fakeLog();
      const gh = fakeGitHub();
      const r = await accept(log, githubTicketStore(gh.client), { kind });
      expect(r.ok).toBe(false);
      expect(r.detail).toMatch(/source\.kinds|needs a kind/);
      expect(gh.issues).toEqual([]);
      expect(log.typesOn(stream)).toEqual([]);
    }
  });

  it("does not ask again about a finding the log has already decided", async () => {
    const log = fakeLog();
    const gh = fakeGitHub();
    const tickets = githubTicketStore(gh.client);
    expect((await decline(log)).ok).toBe(true);
    const r = await accept(log, tickets);
    expect(r).toMatchObject({ ok: false });
    expect(r.detail).toContain("already decided");
    expect(gh.issues).toEqual([]);

    const log2 = fakeLog();
    await accept(log2, tickets);
    const twice = await accept(log2, tickets);
    expect(twice).toMatchObject({ ok: false });
    expect(twice.detail).toContain("https://example/212");
    expect(gh.issues).toHaveLength(1);
  });

  it("when the store does not answer, the decision stands and opening again opens the one issue", async () => {
    // GitHub created #212 and the response never arrived.
    const log = fakeLog();
    const gh = fakeGitHub({ afterCreate: async () => { throw new TypeError("fetch failed"); } });
    const tickets = githubTicketStore(gh.client);
    const r = await accept(log, tickets);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("fetch failed");
    expect(r.detail).toContain(`lingtai backlog accept lingtai ${entry.key}`);
    expect(log.typesOn(stream)).toEqual(["FindingAccepted"]);

    // Opening again needs no kind, finds #212, and records it.
    const again = await accept(log, tickets, { kind: undefined });
    expect(again).toMatchObject({ ok: true, externalRef: "212" });
    expect(again.detail).toContain("recorded");
    expect(gh.issues).toHaveLength(1);
    expect(log.typesOn(stream)).toEqual(["FindingAccepted", "FindingProposed"]);
  });

  it("when the log does not record the issue, opening again records it and opens nothing", async () => {
    const log = fakeLog({ failAppend: "FindingProposed" });
    const gh = fakeGitHub();
    const tickets = githubTicketStore(gh.client);
    const r = await accept(log, tickets);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("Connection terminated");
    log.heal();
    expect(await accept(log, tickets)).toMatchObject({ ok: true, externalRef: "212" });
    expect(gh.issues).toHaveLength(1);
  });

  it("refuses a different kind when opening an accepted entry again", async () => {
    const log = fakeLog();
    const tickets: TicketStore = { source: "fake", propose: async () => { throw new Error("down"); }, withdraw: async () => {} };
    await accept(log, tickets, { kind: "bug" });
    const r = await accept(log, tickets, { kind: "feature" });
    expect(r).toMatchObject({ ok: false });
    expect(r.detail).toContain('accepted as "bug"');
  });

  it("a decline cannot land while an accept is opening its issue, however long that takes", async () => {
    // The reviewer's scenario for attempt 2: person A's POST stalls, person B
    // declines, A's POST completes. Here B's decline runs inside A's POST.
    const log = fakeLog();
    let declined: Awaited<ReturnType<typeof declineFinding>> | undefined;
    const gh = fakeGitHub({ beforeCreate: async () => { declined = await decline(log); } });
    const r = await accept(log, githubTicketStore(gh.client));
    expect(declined).toMatchObject({ ok: false });
    expect(declined!.detail).toContain("was accepted");
    expect(r).toMatchObject({ ok: true, externalRef: "212" });
    expect(log.typesOn(stream)).toEqual(["FindingAccepted", "FindingProposed"]);
  });

  it("a second opener while the first's POST is stalled converges on one open issue the log names", async () => {
    const log = fakeLog();
    const holder: { tickets?: TicketStore } = {};
    let second: Awaited<ReturnType<typeof acceptFinding>> | undefined;
    const gh = fakeGitHub({ beforeCreate: async () => { second = await accept(log, holder.tickets!, { kind: undefined }); } });
    holder.tickets = githubTicketStore(gh.client);
    const first = await accept(log, holder.tickets);

    expect(second).toMatchObject({ ok: true, externalRef: "212" });
    expect(first).toMatchObject({ ok: true, externalRef: "212" });
    expect(gh.open().map((i) => i.number)).toEqual([212]);
    expect(log.typesOn(stream)).toEqual(["FindingAccepted", "FindingProposed"]);
    expect((log.dataOn(stream)[1] as { externalRef: string }).externalRef).toBe("212");
  });

  it("an opener whose issue the log did not record withdraws it", async () => {
    // Both openers wrote before either could see the other's issue — a listing
    // that lagged — and the other recorded first.
    const log = fakeLog();
    let n = 300;
    const mine: TicketStore & { withdrawn: string[] } = {
      source: "fake",
      withdrawn: [],
      async propose() {
        const ref = { externalRef: String(n), url: null, created: true };
        if (n === 300) {
          n++;
          // The other opener, recording #301 while this one's answer is on its way.
          const other = await accept(log, mine, { kind: undefined });
          expect(other).toMatchObject({ ok: true, externalRef: "301" });
        }
        return ref;
      },
      async withdraw(ref, kept) {
        this.withdrawn.push(`${ref}->${kept}`);
      },
    };
    const r = await accept(log, mine);
    expect(r).toMatchObject({ ok: true, externalRef: "301" });
    expect(r.detail).toContain("closed");
    expect(mine.withdrawn).toEqual(["300->301"]);
  });

  it("opens nothing when a decline landed first", async () => {
    const log = fakeLog();
    const gh = fakeGitHub();
    // The decline appends between this accept's read and its append.
    const read = log.store.read.bind(log.store);
    let once = true;
    (log.store as { read: EventStore["read"] }).read = async (s: string) => {
      const out = await read(s);
      if (once) {
        once = false;
        await decline(log);
      }
      return out;
    };
    const r = await accept(log, githubTicketStore(gh.client));
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("nothing was opened");
    expect(gh.issues).toEqual([]);
    expect(log.typesOn(stream)).toEqual(["FindingDeclined"]);
  });
});

describe("declineFinding", () => {
  it("records the decline with its reason", async () => {
    const log = fakeLog();
    const r = await decline(log, { by: "human:steven", reason: "style only" });
    expect(r.ok).toBe(true);
    expect(log.dataOn(stream)).toEqual([{ project: "lingtai", key: entry.key, by: "human:steven", reason: "style only" }]);
  });

  it("refuses a decline with no reason, or by no person", async () => {
    const log = fakeLog();
    expect((await decline(log, { reason: "  " })).ok).toBe(false);
    expect((await decline(log, { by: "conductor" })).ok).toBe(false);
    expect(log.typesOn(stream)).toEqual([]);
  });
});
