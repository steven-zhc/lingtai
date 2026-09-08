/**
 * A whole pass, against fakes, with no database.
 *
 * **This is the test `#68` said would decide whether the extraction happened.**
 * Its own words: *can `conductor` run a whole pass against a fake `repo`, a
 * fake `agent` and a fake `event-store`, with no database — producing the
 * events it wants appended and the calls it wants made, for a test to assert?*
 * Before the ports it could not: every one of this package's tests appends real
 * events, and the suite refuses to start without `TEST_DATABASE_URL`.
 *
 * It runs under `vitest.pure.config.ts`, which has **no `globalSetup`**. That
 * is not tidiness — the shared teardown connects to Postgres, so a pure test
 * under the ordinary config would prove nothing about whether `runOnce` needs
 * one. Nothing in this file imports `pg`, `@lingtai/repo` or `@lingtai/agent`.
 *
 * What it asserts is the *decision*: which events a held run appends, in order,
 * and that the worktree is removed on the way out. Not the git, not the socket
 * — those have their own tests, in the packages that own them.
 */
import type { Envelope, ToAppend } from "@lingtai/domain";
import type { EventStore } from "@lingtai/event-store";
import type { GitHubClient, Issue } from "@lingtai/github";
import type { Runtime } from "@lingtai/agent";
import type { ProjectState } from "@lingtai/domain";
import { describe, expect, it } from "vitest";
import type { RunPorts } from "../src/ports.ts";
import { runOnce } from "../src/run-once.ts";

const PROJECT = "purecheck";

/**
 * The log, in a Map.
 *
 * Enough of `EventStore` to be one: append refuses on a stale version, exactly
 * as `UNIQUE (stream_id, version)` does, because the conductor's whole mutual
 * exclusion rests on that refusal and a fake that always says yes would test
 * the opposite of what runs.
 */
/** The fake store's own map, for the fakes that need to see it. */
function streams(store: EventStore): Map<string, Envelope[]> {
  return (store as EventStore & { streams: Map<string, Envelope[]> }).streams;
}

function memoryStore(): EventStore & { streams: Map<string, Envelope[]> } {
  const streams = new Map<string, Envelope[]>();
  let seq = 0n;
  return {
    streams,
    async append(streamId: string, expectedVersion: number, events: readonly ToAppend[]) {
      const held = streams.get(streamId) ?? [];
      if (held.length !== expectedVersion) {
        throw new Error(`stale: ${streamId} is at ${held.length}, expected ${expectedVersion}`);
      }
      const written = events.map((e, i) => {
        seq += 1n;
        return {
          seq,
          streamId,
          version: expectedVersion + i + 1,
          type: e.type,
          actor: e.actor,
          data: e.data,
          at: new Date(),
        } as unknown as Envelope;
      });
      streams.set(streamId, [...held, ...written]);
      return written;
    },
    async read(streamId: string, fromVersion = 1) {
      return (streams.get(streamId) ?? []).filter((e) => e.version >= fromVersion);
    },
    async readAll() {
      return [];
    },
  };
}

const RECIPE = `
version: 1
repo: { base: main, submodules: false }
source: { kinds: [bug], exclude: [] }
env: { required: [], plantAt: .env.local }
gates: {}
runtime: { agent: claude-code, limits: { turns: 10, wall: 2m } }
`;

const issue: Issue = {
  number: 7,
  title: "a race in the importer",
  body: "fix it",
  labels: ["bug"],
  state: "open",
  url: "https://example.invalid/7",
};

const project: ProjectState = {
  project: PROJECT,
  owner: "nobody",
  base: "main",
  configHash: "seeded",
  fromSha: "0".repeat(40),
  version: 1,
  lastSeq: null,
};

/** GitHub, as a record of what it was told. */
function fakeGitHub(said: string[]): GitHubClient {
  return {
    owner: "nobody",
    repo: PROJECT,
    installation: { id: 1, permissions: {}, account: "nobody", repositorySelection: "selected" },
    request: async () => { throw new Error("not used"); },
    token: async () => "not-a-real-token",
    defaultBranch: async () => "main",
    fileAt: async (path: string, ref: string) =>
      path === ".lingtai/config.yaml" && ref === "main" ? RECIPE : null,
    refSha: async () => "0".repeat(40),
    listOpenIssues: async () => [issue],
    getIssue: async () => issue,
    comment: async (n: number) => { said.push(`comment #${n}`); return { id: 1 }; },
    setLabels: async (n: number, labels: readonly string[]) => { said.push(`labels #${n} ${[...labels].sort().join(",")}`); },
    closeIssue: async (n: number) => { said.push(`close #${n}`); },
  } as unknown as GitHubClient;
}

/**
 * An agent that says it committed something, without a subprocess.
 *
 * The capabilities are the real shape, not a stub: `missingForTier` reads them
 * and refuses the dispatch if they do not carry the recipe's tier, and a fake
 * that skipped them would skip the refusal this run has to get past.
 */
const runtime: Runtime = {
  capabilities: {
    id: "claude-code",
    hooks: ["PreToolUse", "PostToolUse", "Stop"],
    canBlockToolUse: true,
    canRewriteToolCall: false,
    providesTier: "guarded",
  },
  run: async () => ({
    exitCode: 0,
    turns: 3,
    durationMs: 1234,
    costUsd: 0.42,
    failure: null,
    text: "done",
    sessionId: "sess-1",
  }),
};

/**
 * The world, as a list of what was asked of it.
 *
 * The hook server takes the store because the real one does something a stub
 * cannot fake away: it appends the hook's own events to the run stream, and
 * `runOnce` reads `get(runId).version` afterwards to know where the stream got
 * to. A `get` that returned nothing would send the next append in at the wrong
 * version and the store would refuse it — which is exactly what happened when
 * this fake was a stub, and is the fake being right about the design rather
 * than the design being awkward.
 */
function fakePorts(did: string[], store: EventStore): RunPorts {
  return {
    repo: {
      provision: async (o) => {
        did.push(`provision ${o.runId}`);
        return { path: `/tmp/fake/${o.runId}`, branch: `agent/${o.runId}`, baseSha: "a".repeat(40) } as never;
      },
      remove: async (o) => { did.push(`remove ${o.runId}`); },
      git: async (args) => {
        did.push(`git ${args[0]}`);
        // `rev-parse HEAD` decides the sha every verdict is bound to; `numstat`
        // is what the diff summary is counted from.
        if (args[0] === "rev-parse") return "b".repeat(40);
        if (args[0] === "diff" && args[1] === "--numstat") return "3\t1\tsrc/fix.ts\n";
        if (args[0] === "diff" && args[1] === "--name-only") return "src/fix.ts\n";
        return "";
      },
      integrate: async () => {
        did.push("integrate");
        throw new Error("a held run must not reach the integrator");
      },
    },
    agent: {
      wire: async () => { did.push("wire"); return { settingsPath: "/tmp/fake/settings.json", socketPath: "/tmp/fake/sock", env: {} } as never; },
      smokeTest: async () => { did.push("smokeTest"); return { ok: true, detail: "refuses when it cannot reach the socket" }; },
      serve: () => {
        did.push("serve");
        return {
          socketPath: "/tmp/fake/sock",
          register: (runId: string, version: number) => ({ runId, version }) as never,
          unregister: () => undefined,
          get: ((runId: string) => ({
            runId,
            // Where the stream actually is. The real server knows because it
            // wrote the events itself.
            version: (streams(store).get(runId) ?? []).length,
          })) as never,
          flush: async () => {},
          listen: async () => {},
          close: async () => {},
        } as never;
      },
      resolveEnv: async () => ({ values: {}, names: [], refusal: null }) as never,
    },
  };
}

describe("runOnce, with no world to run in", () => {
  it("holds at the merge, appends what it decided, and takes the worktree down", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const said: string[] = [];

    const result = await runOnce({
      project,
      client: fakeGitHub(said),
      runtime,
      issue: 7,
      hookBinary: "/tmp/fake/lingtai-hook",
      prompt: "fix {{issue}}",
      merge: false,
      home: "/tmp/fake-home",
      store,
      ports: fakePorts(did, store),
    });

    // Say what it actually did before asserting, so a refusal names its stage
    // rather than reading as `false`.
    if (result.ok === false) throw new Error(`stopped at ${result.stage}: ${result.detail}`);
    expect(result.ok).toBe("held");

    // The decision, as the log records it.
    const item = (await store.read(`wi-${PROJECT}-7`)).map((e) => e.type);
    expect(item).toContain("WorkItemClaimed");
    expect(item).toContain("WorkItemBlocked");
    // Told GitHub inline, and recorded that it did (0022 — no outbox).
    expect(item.filter((t) => t === "IssueUpdated").length).toBeGreaterThan(0);

    // `working` at the claim, `waiting` once a person is the thing being waited
    // on — and in that order, which is the whole of `#71`. `bug` survives both,
    // because a whole-set write takes the union with somebody else's labels.
    const labelWrites = said.filter((line) => line.startsWith("labels #7"));
    expect(labelWrites).toEqual(["labels #7 bug,lingtai:working", "labels #7 bug,lingtai:waiting"]);

    // The worktree is gone, and the integrator was never reached.
    expect(did).toContain(`provision ${result.runId}`);
    expect(did).toContain(`remove ${result.runId}`);
    expect(did).not.toContain("integrate");

    // The hook was wired and proved to fail closed before the agent started.
    expect(did.indexOf("smokeTest")).toBeLessThan(did.indexOf("git rev-parse"));
  });
});
