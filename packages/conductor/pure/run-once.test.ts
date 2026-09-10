/**
 * A whole pass, against fakes, with no database.
 *
 * **This is the test `#68` said would decide whether the extraction happened.**
 * Its own words: *can `conductor` run a whole pass against a fake `repo`, a
 * fake `agent` and a fake `event-store`, with no database — producing the
 * events it wants appended and the calls it wants made, for a test to assert?*
 * Before the ports it could not: every one of this package's tests appends real
 * events, and the suite refuses to start without `LINGTAI_TEST_DATABASE_URL`.
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
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { AgentHost, Repo, type RunPorts } from "../src/ports.ts";
import { runOnce } from "../src/run-once.ts";

/**
 * The two tags, from the plain shape.
 *
 * `runOnce` asks for `Repo` and `AgentHost` rather than taking a `RunPorts`
 * parameter ([0026](../../../doc/decisions/0026-the-conversion-past-the-seam.md)),
 * so a test provides them the way a host does. `RunPorts` survives as exactly
 * this: the shape a `Layer` is built from.
 */
const withPorts = (ports: RunPorts) =>
  Layer.merge(Layer.succeed(Repo, ports.repo), Layer.succeed(AgentHost, ports.agent));

const once = (options: Parameters<typeof runOnce>[0], ports: RunPorts) =>
  Effect.runPromise(runOnce(options).pipe(Effect.provide(withPorts(ports))));

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
  labels: [{ name: "bug", color: "#d73a4a" }],
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
    enforces: ["turns", "wall"],
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
 * The six runs of ninety-two seconds, as one runtime.
 *
 * Zero turns, zero cost, an error — the three facts
 * [0031](../../../doc/decisions/0031-a-run-that-never-started.md) §1 names, and
 * the prose it refuses to classify on, kept whole as the detail.
 */
const quotaRuntime: Runtime = {
  ...runtime,
  run: async () => ({
    exitCode: 1,
    turns: 0,
    durationMs: 25_000,
    costUsd: 0,
    failure: {
      kind: "never-started",
      detail: "You've hit your session limit \u00b7 resets 11pm (America/Chicago)",
    },
    text: null,
    sessionId: "sess-quota",
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
function fakePorts(did: string[], store: EventStore, merges = false): RunPorts {
  return {
    repo: {
      provision: (o) =>
        Effect.sync(() => {
          did.push(`provision ${o.runId}`);
          return { path: `/tmp/fake/${o.runId}`, branch: `agent/${o.runId}`, baseSha: "a".repeat(40) } as never;
        }),
      remove: (o) => Effect.sync(() => void did.push(`remove ${o.runId}`)),
      git: (args) =>
        Effect.sync(() => {
          did.push(`git ${args[0]}`);
          // `rev-parse HEAD` decides the sha every verdict is bound to; `numstat`
          // is what the diff summary is counted from.
          if (args[0] === "rev-parse") return "b".repeat(40);
          if (args[0] === "diff" && args[1] === "--numstat") return "3\t1\tsrc/fix.ts\n";
          if (args[0] === "diff" && args[1] === "--name-only") return "src/fix.ts\n";
          return "";
        }),
      integrate: () =>
        Effect.sync(() => {
          did.push("integrate");
          if (!merges) throw new Error("a held run must not reach the integrator");
          return { ok: true, mergeCommit: "c".repeat(40) } as never;
        }),
    },
    agent: {
      wire: () =>
        Effect.sync(() => {
          did.push("wire");
          return { settingsPath: "/tmp/fake/settings.json", socketPath: "/tmp/fake/sock", env: {} } as never;
        }),
      smokeTest: () =>
        Effect.sync(() => {
          did.push("smokeTest");
          return { ok: true, detail: "refuses when it cannot reach the socket" };
        }),
      // Acquired and released, because that is what the port now says it is.
      // The `close` this records is the one `run-once.ts` used to make in a
      // `finally`; here nothing calls it, and it still happens.
      serve: () =>
        Effect.acquireRelease(
          Effect.sync(() => {
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
          }),
          () => Effect.sync(() => void did.push("close")),
        ),
      resolveEnv: () => Effect.succeed({ values: {}, names: [], refusal: null }) as never,
      /**
       * The run's log, as a list of what was written to it and how it ended.
       *
       * Nothing is opened: the point of the fake is that the *fate* is
       * assertable — landed → delete, did not land → keep
       * ([0034](../../../doc/decisions/0034-the-run-log.md) §4) — and a real
       * file would put that decision behind a `stat` in a test whose whole
       * claim is that it needs no world to run in.
       */
      runLog: (o) =>
        Effect.sync(() => {
          did.push(`runLog ${o.path}`);
          return {
            path: o.path,
            note: (label: string, detail = "") => void did.push(`note ${label} ${detail}`.trimEnd()),
            close: async (fate: "keep" | "delete") => void did.push(`runLog ${fate}`),
          };
        }),
    },
  };
}

describe("runOnce, with no world to run in", () => {
  it("holds at the merge, appends what it decided, and takes the worktree down", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const said: string[] = [];

    const result = await once(
      {
        project,
        client: fakeGitHub(said),
        runtime,
        issue: 7,
        hookBinary: "/tmp/fake/lingtai-hook",
        prompt: "fix {{issue}}",
        merge: false,
        home: "/tmp/fake-home",
        store,
      },
      fakePorts(did, store),
    );

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
    // The socket was closed, by the scope and not by a `finally`, and before
    // the worktree it outlived — releases run in the reverse of acquisition.
    expect(did.indexOf("close")).toBeLessThan(did.indexOf(`remove ${result.runId}`));

    /**
     * **The log outlives the worktree, and a run that did not land keeps it.**
     *
     * Both halves of 0034 §2 and §4. The worktree is removed before the merge —
     * git refuses to update a ref some worktree has checked out — so a log
     * inside it would die before the run had an outcome, and the log worth
     * reading is always the one from the run that just failed. This one held at
     * the merge for a person: nothing landed, so nothing is deleted.
     */
    expect(did).toContain(`runLog /tmp/fake-home/runs/${PROJECT}/${result.runId}.log`);
    expect(did.indexOf(`remove ${result.runId}`)).toBeLessThan(did.indexOf("runLog keep"));
    expect(did).not.toContain("runLog delete");
    // And the hook socket's live view reached it — the callback that has
    // existed since the socket did and had no consumer until now.
    expect(did).toContain(`note run finished: 3 turns, 0.42 usd`);
  });

  /**
   * **Landed → delete**, which is the other half of the rule and the expensive
   * one to get wrong.
   *
   * `#84` cost $26.53 and, once landed, what it was thinking is gone. That is
   * accepted rather than regretted (0034 §4): the diff is on the branch and the
   * events are on the log, so an agent's account of a run that *worked* has the
   * least marginal value of anything here. What the rule buys is that no timer,
   * no sweeper and no retention period is needed — what survives on disk is
   * exactly the set somebody might have to explain.
   */
  it("deletes the log of a run that landed, and keeps nothing else to sweep", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const said: string[] = [];

    const result = await once(
      {
        project,
        client: fakeGitHub(said),
        runtime,
        issue: 7,
        hookBinary: "/tmp/fake/lingtai-hook",
        prompt: "fix {{issue}}",
        merge: true,
        home: "/tmp/fake-home",
        store,
      },
      fakePorts(did, store, true),
    );

    if (result.ok === false) throw new Error(`stopped at ${result.stage}: ${result.detail}`);
    expect(result.ok).toBe(true);
    expect((await store.read(`wi-${PROJECT}-7`)).map((e) => e.type)).toContain("WorkItemLanded");

    // The decision is taken *after* the integrator, which is the whole reason
    // this scope is wider than the worktree's: at the moment the worktree goes,
    // whether the run landed is not yet a fact about the world.
    expect(did.indexOf("integrate")).toBeLessThan(did.indexOf("runLog delete"));
    expect(did).not.toContain("runLog keep");
  });

  /**
   * **Where the scope starts is a decision**, and this is the assertion of it.
   *
   * 0024 recorded what the first conversion taught: a `Layer` is built where it
   * is provided, so a scope opened too early acquires what a refusal would have
   * made unnecessary — `lingtai run no-such-project` opening a Postgres
   * connection to say a project does not exist. `runOnce` refuses on the
   * recipe, the environment, the dispatch tier and the claim before it
   * provisions anything, and the way to prove that is not to read the file: it
   * is to reach a refusal and find that the worktree was never asked for.
   */
  it("refuses before it acquires anything, so there is no worktree to release", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const said: string[] = [];

    const result = await once(
      {
        project,
        // No recipe on the base branch. The first refusal there is.
        client: { ...fakeGitHub(said), fileAt: async () => null } as GitHubClient,
        runtime,
        issue: 7,
        hookBinary: "/tmp/fake/lingtai-hook",
        prompt: "fix {{issue}}",
        home: "/tmp/fake-home",
        store,
      },
      fakePorts(did, store),
    );

    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    expect(result.stage).toBe("recipe");
    // Nothing was claimed, so there is nothing to release …
    expect(result.workItemId).toBeNull();
    expect(await store.read(`wi-${PROJECT}-7`)).toEqual([]);
    // … and nothing was acquired, so there is nothing to unwind.
    expect(did).toEqual([]);
  });

  /**
   * **Eighty events in ninety-two seconds, answered once.**
   *
   * Six runs, six claims, six worktrees, six branches and `costUsd` of nothing
   * on every one of them — because per-item backoff was answering a condition
   * that was never about the item
   * ([0031](../../../doc/decisions/0031-a-run-that-never-started.md) §3). Each
   * attempt still releases its own item and keeps its place; what is asserted
   * here is that the *account-wide* answer is given once, on the first one, and
   * that the five after it leave the pause exactly as they found it.
   *
   * A `run-once` cannot prove the other half — that nothing is taken while the
   * pause holds — because it is the daemon's loop that asks. That is
   * `work-loop.test.ts`'s, and this is the half that appends.
   */
  it("pauses the conductor once, however many runs never start", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const said: string[] = [];

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const result = await once(
        {
          project,
          client: fakeGitHub(said),
          runtime: quotaRuntime,
          issue: 7,
          hookBinary: "/tmp/fake/lingtai-hook",
          prompt: "fix {{issue}}",
          merge: false,
          home: "/tmp/fake-home",
          store,
        },
        fakePorts(did, store),
      );
      expect(result.ok, `attempt ${attempt + 1}`).toBe(false);
    }

    // Every run said what it was, in the vocabulary that is checkable. `crash`
    // is what all six of them said before, which is why the night was
    // unreadable from the log.
    const runs = [...streams(store)].filter(([id]) => id.startsWith("run-"));
    const endings = runs.flatMap(([, events]) =>
      events.filter((e) => e.type === "RunFailed").map((e) => (e.data as { kind: string }).kind),
    );
    expect(endings).toEqual(Array.from({ length: 6 }, () => "never-started"));

    // The items keep their place: each attempt released, as any failed run does.
    const item = await store.read(`wi-${PROJECT}-7`);
    const releases = item.filter((e) => e.type === "WorkItemReleased");
    expect(releases).toHaveLength(6);

    // **And each release says what happened, which is the card's whole line.**
    // `WorkItemReleased.reason` overwrites the note the projection wrote from
    // `RunFailed`, so `run failed: ${kind}` was where the reason stopped: the
    // prose was in the history and the card said `run failed: crash` (0031 §6,
    // `#100`). Both halves are asserted because both were missing — the
    // runtime's own words, and that this attempt cost nothing, which is what
    // separates it from one that spent an agent and produced nothing.
    const reason = (releases[0]!.data as { reason: string }).reason;
    expect(reason).toContain("You've hit your session limit");
    expect(reason).toContain("nothing was spent");

    // And the account-wide answer was given exactly once.
    const control = await store.read("ctl-conductor");
    const paused = control.filter((e) => e.type === "ConductorPaused");
    expect(paused).toHaveLength(1);

    const d = paused[0]!.data as { by: string; reason: string; until: string };
    expect(d.by).toBe("lingtai");
    // Read out of the message, not guessed at: 11pm in Chicago, as an instant.
    expect(new Date(d.until).getUTCHours()).toBe(4);
    // The evidence the classification would not read is on the pause, because
    // this is the only place a person can learn what actually stopped the queue.
    expect(d.reason).toContain("You've hit your session limit");
  });

  /**
   * **"Every exit appends", as a test rather than as a comment.**
   *
   * It was a `catch (err)` whose own comment admitted what it was: *"the
   * catch-all that keeps 'every exit appends' true for anything unforeseen"*.
   * A defect is what "unforeseen" means once the failures have types, so this
   * throws one from a port that the type system says cannot fail, and asks the
   * log the question the comment was answering.
   */
  it("releases and appends when something no type predicted goes wrong", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const said: string[] = [];

    const ports = fakePorts(did, store);
    const result = await once(
      {
        project,
        client: fakeGitHub(said),
        runtime,
        issue: 7,
        hookBinary: "/tmp/fake/lingtai-hook",
        prompt: "fix {{issue}}",
        merge: false,
        home: "/tmp/fake-home",
        store,
      },
      {
        ...ports,
        agent: {
          ...ports.agent,
          // Not a refusal — `smokeTest` answers `{ ok: false }` for that. This
          // is the port breaking its own contract, which is a defect.
          smokeTest: () =>
            Effect.sync(() => {
              throw new Error("the socket directory is not writable");
            }),
        },
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    expect(result.stage).toBe("unexpected");
    expect(result.detail).toContain("not writable");

    // The item is back in the queue rather than claimed by a run that is over,
    // and the log says so. That is the whole of the guarantee.
    const item = (await store.read(`wi-${PROJECT}-7`)).map((e) => e.type);
    expect(item).toContain("WorkItemClaimed");
    expect(item).toContain("WorkItemReleased");

    // And the worktree it had already taken went with it.
    expect(did).toContain(`remove ${result.runId}`);
  });
});
