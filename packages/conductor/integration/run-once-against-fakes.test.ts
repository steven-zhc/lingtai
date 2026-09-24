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
 * Nothing in this file imports `pg`, `@lingtai/repo` or `@lingtai/agent`, and
 * no test in it opens a connection. **It is in `integration/` for one
 * `describe`**: *runOnce judges a change by the machine's recipe* writes a
 * `recipe.yml` into a temporary `LINGTAI_HOME`, and the filesystem is outside
 * the system ([0060](../../../doc/decisions/0060-the-gate-runs-unit-tests.md)
 * §1). Nineteen of the twenty tests here are unit and #225 moved them anyway,
 * because it drew the line at the file. **This is the file a tag is for** — the
 * one that is mostly unit and reaches out once — and splitting it, by a tag or
 * by moving that `describe` out, is the way the claims below come back to the
 * gate.
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
import { resolveRecipe } from "@lingtai/recipe";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  Effect.runPromise(
    runOnce({
      // The recipe through the fake GitHub's `fileAt`, so each test keeps the
      // recipe it wrote. Where a real run reads it from is `local.test.ts`'s.
      recipe: () =>
        resolveRecipe((p, r) => options.client.fileAt(p, r), options.project.base ?? "main"),
      ...options,
    }).pipe(Effect.provide(withPorts(ports))),
  );

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
version: 2
repo: { base: main, submodules: false }
source: { kinds: [bug], exclude: [] }
env: { required: [], plantAt: .env.local }
steps: {}
runtime: { agent: claude-code, limits: { turns: 10, wall: 2m } }
`;

/**
 * The same, with a cold reviewer at `proposed` and no round to patch with.
 *
 * `rounds: 0` and a non-zero `restarts` is the configuration
 * [0040](../../../doc/decisions/0040-rounds-bound-depth-restarts-bound-breadth.md)
 * makes legible — *never patch, start over twice* — and it is also the shortest
 * path to the branch under test: one review, refused, and the depth ceiling
 * spent by the recipe rather than by three agent runs.
 */
const restartRecipe = (restarts: number) => `
version: 2
repo: { base: main, submodules: false }
source: { kinds: [bug], exclude: [] }
env: { required: [], plantAt: .env.local }
steps:
  proposed:
    - name: review
      agent: claude-code
      prompt: look at it coldly
runtime:
  agent: claude-code
  limits: { turns: 10, wall: 2m, rounds: 0, restarts: ${restarts} }
`;

/**
 * The same recipe with the cold reviewer this repository actually runs.
 *
 * The reviewer alone, and no `run:` action beside it: a command would spawn a
 * subprocess in a worktree that does not exist, and the whole claim of this
 * file is that it needs no world. What `#133` is about is the *second* agent in
 * a pass, and this is the second agent.
 */
const REVIEWED = `
version: 2
repo: { base: main, submodules: false }
source: { kinds: [bug], exclude: [] }
env: { required: [], plantAt: .env.local }
steps:
  proposed:
    - name: review
      agent: claude-code
      prompt: look for races
runtime: { agent: claude-code, limits: { turns: 10, wall: 2m } }
`;

const issue: Issue = {
  number: 7,
  title: "a race in the importer",
  body: "fix it",
  labels: [{ name: "bug", color: "#d73a4a" }],
  state: "open",
  url: "https://example.invalid/7",
  dependencies: { blockedBy: 0, totalBlockedBy: 0 },
  assignees: [],
};

const project: ProjectState = {
  project: PROJECT,
  owner: "nobody",
  base: "main",
  configHash: "seeded",
  fromSha: "0".repeat(40),
  refused: null,
  version: 2,
  lastSeq: null,
};

/** GitHub, as a record of what it was told. */
function fakeGitHub(said: string[], recipe = RECIPE): GitHubClient {
  return {
    owner: "nobody",
    repo: PROJECT,
    installation: { id: 1, permissions: {}, account: "nobody", repositorySelection: "selected", htmlUrl: null },
    request: async () => { throw new Error("not used"); },
    token: async () => "not-a-real-token",
    defaultBranch: async () => "main",
    fileAt: async (path: string, ref: string) =>
      path === ".lingtai/config.yaml" && ref === "main" ? recipe : null,
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
    canFailClosed: true,
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
 * A runtime that refuses whatever it is shown, in the reviewer's own contract.
 *
 * One runtime for every agent in the pass, which is what `runOnce` has: the
 * implementer's `text` is only ever read as a decline message, so a
 * runtime that answers findings to both is the cheapest way to get a cold
 * review to refuse without a subprocess. `blocker` is what makes `verdictFor`
 * say `failed`, and the scenario is what makes the finding survive
 * `parseFindings` — a finding without one is dropped rather than repaired.
 */
const refusingRuntime: Runtime = {
  ...runtime,
  run: async () => ({
    exitCode: 0,
    turns: 5,
    durationMs: 2_000,
    costUsd: 1.25,
    failure: null,
    text: JSON.stringify({
      findings: [
        {
          file: "src/fix.ts",
          line: 12,
          severity: "blocker",
          claim: "the approach cannot work",
          failureScenario: "call it twice and the second call deadlocks on the lock the first took",
        },
      ],
    }),
    sessionId: "sess-review",
  }),
};

/**
 * The reviewer of `run-9e510ffc`: exit 1 in a second, nothing on the stream.
 *
 * `crash` and not `never-started`, which is the whole distinction `#196` turns
 * on. The three facts 0031 §1 names are not all here — zero turns and zero cost,
 * yes, but the cause is a session id this binary has already been given
 * (`#195`), a settings path that does not exist, a binary that is not there.
 * The adapter says `crash`; nothing downstream re-reads the message to disagree
 * ([0057](../../../doc/decisions/0057-a-gate-that-did-not-finish.md)).
 *
 * `tried.n` counts the reviewer's attempts, and the assertion on it is that
 * there is exactly one: the pipeline runs the action once (`#234`). It took
 * `after` — how many attempts crash before it starts answering — while 0057 §4's
 * retry existed, and the arm that arrangement needed, a reviewer a retry
 * rescues, is a shape nothing can produce now.
 */
function reviewerThatCrashes(tried: { n: number }): Runtime {
  return {
    ...runtime,
    run: async (request) => {
      if (!request.runId.includes(":review:")) {
        return {
          exitCode: 0,
          turns: 3,
          durationMs: 1234,
          costUsd: 0.42,
          failure: null,
          text: "done",
          sessionId: "sess-1",
        };
      }
      tried.n += 1;
      return {
        exitCode: 1,
        turns: 0,
        durationMs: 1_000,
        costUsd: null,
        failure: {
          kind: "crash",
          detail: `Error: Session ID ${request.runId} is already in use.`,
        },
        text: null,
        sessionId: "sess-review",
      };
    },
  };
}

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
 * The implementer works and is paid for it; the reviewer meets the wall.
 *
 * The shape `#133` is about, and the reason 0031's tests pass while it happens:
 * the run itself never goes near `never-started`, because the run started, took
 * turns and spent money. It is the *second* agent in the pass — the one the
 * `agent` gate asks — that arrives at the account limit, and until `d4fbd1a`
 * that agent had never once run.
 *
 * Told apart by the run id, exactly as the reviewer's own comment says it must
 * be: `agent-gate.ts` runs under `${runId}:review:${name}:${sha}` so that the
 * session id derived from it cannot resume the implementer's — nor, since
 * `#195`, the previous round's reviewer's.
 */
const reviewerAtTheWall: Runtime = {
  ...runtime,
  run: async (request) =>
    request.runId.includes(":review:")
      ? {
          exitCode: 1,
          turns: 0,
          durationMs: 8_000,
          costUsd: 0,
          failure: {
            kind: "never-started",
            detail: "You've hit your session limit \u00b7 resets 2pm (America/Chicago)",
          },
          text: null,
          sessionId: "sess-review",
        }
      : {
          exitCode: 0,
          turns: 3,
          durationMs: 1234,
          costUsd: 0.42,
          failure: null,
          text: "done",
          sessionId: "sess-1",
        },
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
          // The refspecs too, for a push and only for a push: *which refs* is
          // the whole of what the restart path needs from it, since the branch
          // the next attempt is told to fetch and the branch this arm keeps
          // for the card are two different names. Everything else is
          // assertable by its verb.
          did.push(
            args[0] === "push"
              ? `git push ${args.filter((a) => a.includes(":refs/heads/")).join(" ")}`
              : `git ${args[0]}`,
          );
          // `rev-parse HEAD` decides the sha every verdict is bound to; `numstat`
          // is what the diff summary is counted from.
          if (args[0] === "rev-parse") return "b".repeat(40);
          if (args[0] === "diff" && args[1] === "--numstat") return "3\t1\tsrc/fix.ts\n";
          if (args[0] === "diff" && args[1] === "--name-only") return "src/fix.ts\n";
          // `base...HEAD`, which is what a reviewer is shown. Non-empty on
          // purpose: an `agent:` gate short-circuits to `passed` on an empty
          // diff, so a fake that answered "" would make every review pass and
          // the refusal under test unreachable.
          if (args[0] === "diff") return "diff --git a/src/fix.ts b/src/fix.ts\n+  return ok;\n";
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
   * `#89`: a run stopped at its turns spent the most, and the log has to say so
   * where spend is read — `RunFinished.costUsd` — and not only in the prose.
   */
  it("records the receipt of a run stopped at its turns, and still ends it as failed", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const said: string[] = [];

    const result = await once(
      {
        project,
        client: fakeGitHub(said),
        runtime: {
          ...runtime,
          run: async () => ({
            exitCode: 1,
            turns: 150,
            durationMs: 900_000,
            costUsd: 24.1,
            failure: { kind: "out-of-turns", detail: "150 turns, and the recipe allows 150 · $24.10" },
            text: null,
            sessionId: "sess-turns",
          }),
        },
        issue: 7,
        hookBinary: "/tmp/fake/lingtai-hook",
        prompt: "fix {{issue}}",
        merge: false,
        home: "/tmp/fake-home",
        store,
      },
      fakePorts(did, store),
    );
    expect(result.ok).toBe(false);

    const [, events] = [...streams(store)].find(([id]) => id.startsWith("run-"))!;
    const endings = events.filter((e) => e.type === "RunFinished" || e.type === "RunFailed");
    expect(endings.map((e) => e.type)).toEqual(["RunFinished", "RunFailed"]);
    expect(endings[0]!.data).toEqual({ exitCode: 1, turns: 150, durationMs: 900_000, costUsd: 24.1 });
    expect((endings[1]!.data as { kind: string }).kind).toBe("out-of-turns");

    // **Held, not released.** A release puts the item back in the queue, and
    // the next pass after the backoff would buy another run to the same limit
    // — every backoff, with nothing counting. The limit's reading is that the
    // ticket was wrong, which is a person's to fix.
    const item = (await store.read(`wi-${PROJECT}-7`)).map((e) => e.type);
    expect(item).toContain("WorkItemBlocked");
    expect(item).not.toContain("WorkItemReleased");
  });

  /**
   * **The wall met by the agent *inside a gate*, which is the path 0031 did not
   * have** (`#133`).
   *
   * 0031's tests pass today and this happened anyway: the run started, took
   * three turns and spent $0.42, so nothing about it is `never-started`. The
   * reviewer is a second agent asking the same account, and what came back was
   * turned into a failed verdict — *a review gate refused it*, a sentence about
   * this diff produced by a condition that has nothing to do with any diff.
   *
   * Four things are asserted because four things were wrong, and the fourth is
   * the one a person would have had to undo by hand:
   *
   *   the verdict   no `GateFailed`, and no `GatePassed` either — a gate whose
   *                 agent never started judged nothing, and both readings are
   *                 claims nobody is entitled to
   *   the conductor stood down, once, until the time the message named — not
   *                 this item backing off while the next one meets the same wall
   *   the item      released, so the queue brings it back on its own
   *   the card      no block, and no approval question, under `--no-merge` —
   *                 which is the flag this repository passes every single time
   */
  it("stands the conductor down when a gate's agent never starts, and blames no diff", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const said: string[] = [];

    const result = await once(
      {
        project,
        client: fakeGitHub(said, REVIEWED),
        runtime: reviewerAtTheWall,
        issue: 7,
        hookBinary: "/tmp/fake/lingtai-hook",
        prompt: "fix {{issue}}",
        // The flag self-hosting always passes. Without the classification this
        // is the line that asks a person to merge "anyway", naming a gate that
        // refused nothing.
        merge: false,
        home: "/tmp/fake-home",
        store,
      },
      fakePorts(did, store),
    );

    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    expect(result.stage).toBe("gate");

    // The run took turns and cost money, so its own ending is not 0031's — the
    // whole reason the dispatch path never sees this.
    const runId = result.runId!;
    const run = (await store.read(runId)).map((e) => e.type);
    expect(run).toContain("RunFinished");
    expect(run).not.toContain("RunFailed");

    // The point was reached and said so, in a type that is not a verdict.
    expect(run).toContain("GateNeverRan");
    expect(run).not.toContain("GateFailed");
    expect(run).not.toContain("GatePassed");
    const neverRan = (await store.read(runId)).find((e) => e.type === "GateNeverRan");
    const gate = neverRan!.data as { gate: string; action: string; detail: string };
    expect(gate).toMatchObject({ gate: "proposed", action: "review" });
    // The runtime's own words, kept whole: evidence about the account, and the
    // only place the reset time can be read back out of (0031 §4).
    expect(gate.detail).toContain("You've hit your session limit");

    // Released, not blocked: the queue brings it back with nobody requeueing it,
    // and no question was put to a person about a diff nothing read.
    const item = (await store.read(`wi-${PROJECT}-7`)).map((e) => e.type);
    expect(item).toContain("WorkItemReleased");
    expect(item).not.toContain("WorkItemBlocked");
    expect(item).not.toContain("ApprovalRequested");
    expect(did).not.toContain("integrate");

    // And the card's own line says what happened rather than naming a refusal.
    const released = (await store.read(`wi-${PROJECT}-7`)).find(
      (e) => e.type === "WorkItemReleased",
    );
    const reason = (released!.data as { reason: string }).reason;
    expect(reason).toContain("never ran");
    expect(reason).toContain("nothing judged this diff");
    expect(reason).not.toContain("refused");
    // And not the *run*'s sentence either: this attempt did spend an agent, and
    // `the run never started — nothing was spent` would be a claim about a run
    // that took three turns and cost $0.42.
    expect(reason).not.toContain("nothing was spent");

    // The account-wide answer, given where 0031 gives it: once, on the control
    // stream, until the time the message named. 2pm in Chicago is 19:00 UTC.
    const control = await store.read("ctl-conductor");
    const paused = control.filter((e) => e.type === "ConductorPaused");
    expect(paused).toHaveLength(1);
    const pause = paused[0]!.data as { by: string; reason: string; until: string };
    expect(pause.by).toBe("lingtai");
    expect(new Date(pause.until).getUTCHours()).toBe(19);
    expect(pause.reason).toContain("You've hit your session limit");
    // And the chip's sentence is about the gate, not about the run. This pass
    // took three turns and cost $0.42, so 0031's opening would be false here —
    // the same wrong sentence as the card's, one screen along (0041 §3).
    expect(pause.reason).toContain("gate's agent never started");
    expect(pause.reason).not.toContain("no turns taken, nothing spent");

    // Pushed before it let go, so the next attempt's `git fetch origin agent/<n>`
    // finds the work the implementer was paid for.
    expect(did).toContain("git push HEAD:refs/heads/agent/7");
    // And no round was bought from the account that just refused an agent.
    expect(run).not.toContain("FixRequested");
  });

  /**
   * **A push that fails does not take the stand-down with it.**
   *
   * The push is for the next attempt; the pause is the answer to the account.
   * When the push went first and failed, the pass ended as `push: …` — released
   * with no pause, so the next claim met the same wall and the card blamed a
   * push for a quota. A lease `agent/<n>` moved past, or a dropped network, is
   * all it took.
   */
  it("stands the conductor down even when the branch will not push", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const said: string[] = [];
    const fake = fakePorts(did, store);
    const ports: RunPorts = {
      ...fake,
      repo: {
        ...fake.repo,
        git: (args, o) =>
          args[0] === "push"
            ? Effect.fail({ _tag: "RepoFailed", operation: "git push", detail: "stale info: agent/7 moved" } as never)
            : fake.repo.git(args, o),
      },
    };

    const result = await once(
      {
        project,
        client: fakeGitHub(said, REVIEWED),
        runtime: reviewerAtTheWall,
        issue: 7,
        hookBinary: "/tmp/fake/lingtai-hook",
        prompt: "fix {{issue}}",
        merge: false,
        home: "/tmp/fake-home",
        store,
      },
      ports,
    );

    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    expect(result.stage).toBe("gate");

    const paused = (await store.read("ctl-conductor")).filter((e) => e.type === "ConductorPaused");
    expect(paused).toHaveLength(1);

    const item = await store.read(`wi-${PROJECT}-7`);
    const reason = (item.find((e) => e.type === "WorkItemReleased")!.data as { reason: string }).reason;
    expect(reason).toContain("never ran");
    expect(reason).not.toMatch(/^push:/);
    // Said, rather than swallowed: the next attempt will not find the branch.
    expect(reason).toContain("was not pushed");
  });

  /**
   * **The third agent in a pass meets the same wall.**
   *
   * A refused review buys a fixer (0038), and the fixer asks the same account.
   * Arriving as a crash, it used to end as a declined round — a block, asking a
   * person about a refusal nothing had tried to answer, and needing a person to
   * requeue it once the limit lifted. It is the account's ending, so it is
   * answered as the gate's is (0041).
   */
  it("stands the conductor down when the fixing agent never starts, rather than blocking", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const said: string[] = [];

    const result = await once(
      {
        project,
        client: fakeGitHub(said, REVIEWED),
        runtime: {
          ...refusingRuntime,
          run: async (request) =>
            request.runId.includes(":fix:")
              ? {
                  exitCode: 1,
                  turns: 0,
                  durationMs: 5_000,
                  costUsd: 0,
                  failure: {
                    kind: "never-started",
                    detail: "You've hit your session limit · resets 2pm (America/Chicago)",
                  },
                  text: null,
                  sessionId: "sess-fix",
                }
              : refusingRuntime.run(request),
        },
        issue: 7,
        hookBinary: "/tmp/fake/lingtai-hook",
        prompt: "fix {{issue}}",
        merge: false,
        home: "/tmp/fake-home",
        store,
      },
      fakePorts(did, store),
    );

    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    expect(result.stage).toBe("fix");

    const run = (await store.read(result.runId!)).map((e) => e.type);
    // The review did refuse, and a round was bought — both true, both kept.
    expect(run).toContain("GateFailed");
    expect(run).toContain("FixRequested");

    const item = await store.read(`wi-${PROJECT}-7`);
    const types = item.map((e) => e.type);
    expect(types).toContain("WorkItemReleased");
    expect(types).not.toContain("WorkItemBlocked");
    expect(types).not.toContain("ApprovalRequested");
    expect(did).not.toContain("integrate");
    const reason = (item.find((e) => e.type === "WorkItemReleased")!.data as { reason: string }).reason;
    expect(reason).toContain("never started");

    const paused = (await store.read("ctl-conductor")).filter((e) => e.type === "ConductorPaused");
    expect(paused).toHaveLength(1);
    const pause = paused[0]!.data as { reason: string };
    expect(pause.reason).toContain("fix review");
    expect(pause.reason).not.toContain("no turns taken, nothing spent");
  });

  /**
   * **The defect `#196` is about: a reviewer that crashed bought a fix round.**
   *
   * The sequence, measured on `#192`'s `run-9e510ffc`: the reviewer exits 1 in
   * one second with no receipt, `agent-gate.ts` returns `failed`, `gate.ts`
   * appends `GateFailed` — the same event a reviewer that read the diff and
   * refused it appends — and `run-once.ts` buys a round. The fixing agent's own
   * first sentence was *I'm not fixing anything this round … the review never
   * looked at the change.*
   *
   * Five things, because five were wrong:
   *
   *   the verdict   no `GateFailed`, and no `GatePassed` — nothing judged the
   *                 diff, and both readings are claims nobody is entitled to
   *   the log       `GateDidNotFinish`, once, for the one run of the action. An
   *                 event and a field, never the evidence text (0057 §1)
   *   the money     **no `FixRequested`** — nothing was learned about the diff,
   *                 so there is nothing for a fixing agent to carry (§2)
   *   the conductor **not** stood down. A crash is local, and stopping the
   *                 queue for it is 0041's category error pointed the other
   *                 way (§3)
   *   the item      a person's, blocked with a diagnosis about the machinery
   */
  it("buys no round for a reviewer that crashed, runs it once, and asks a person", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const said: string[] = [];
    const tried = { n: 0 };

    const result = await once(
      {
        project,
        client: fakeGitHub(said, REVIEWED),
        runtime: reviewerThatCrashes(tried),
        issue: 7,
        hookBinary: "/tmp/fake/lingtai-hook",
        prompt: "fix {{issue}}",
        merge: false,
        home: "/tmp/fake-home",
        store,
      },
      fakePorts(did, store),
    );

    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    expect(result.stage).toBe("gate");

    // Once, and only once (`#234`). 0057 §4's retry recomputed the crashed
    // attempt's session id, so it was refused in zero seconds having reviewed
    // nothing — and the log then said this action did not finish *twice*.
    expect(tried.n).toBe(1);

    const run = await store.read(result.runId!);
    const types = run.map((e) => e.type);
    // The implementer ran and was paid, so this is not the run's own ending.
    expect(types).toContain("RunFinished");
    expect(types).not.toContain("RunFailed");

    expect(types).not.toContain("GateFailed");
    expect(types).not.toContain("GatePassed");
    // Nor 0041's: `never-started` is the adapter's word for an account-wide
    // wall, and nothing here re-read a message to claim one.
    expect(types).not.toContain("GateNeverRan");

    const didNot = run.filter((e) => e.type === "GateDidNotFinish");
    expect(didNot.map((e) => e.data)).toMatchObject([{ gate: "proposed", action: "review" }]);
    // And nothing on it claiming an attempt number: the two fields went with the
    // retry (`#234`), so a reader cannot be told a second attempt happened.
    expect(didNot[0]!.data).not.toHaveProperty("attempt");
    expect(didNot[0]!.data).not.toHaveProperty("retrying");
    // The runtime's own words, about the machinery.
    expect((didNot[0]!.data as { detail: string }).detail).toContain("already in use");

    // **The line this ticket exists for.** `decideFix` never saw it, so no
    // agent was paid to answer a question nobody asked.
    expect(types).not.toContain("FixRequested");
    expect(types).not.toContain("FixDeclined");

    // The conductor is untouched. Every other item in the queue is unaffected
    // by one machine's crashed reviewer.
    expect(await store.read("ctl-conductor")).toHaveLength(0);

    // And the item is a person's, with a diagnosis that names the machinery
    // rather than the diff — blocked, because a release is a backoff and another
    // claim, and the bad settings path or broken binary underneath would meet
    // the next pass the same way, for ever, with nothing counting it.
    const item = await store.read(`wi-${PROJECT}-7`);
    const itemTypes = item.map((e) => e.type);
    expect(itemTypes).toContain("WorkItemBlocked");
    expect(itemTypes).not.toContain("WorkItemReleased");
    expect(did).not.toContain("integrate");
    const block = item.find((e) => e.type === "WorkItemBlocked")!.data as {
      needs: string;
      diagnosis: { what: string; raw: string } | null;
    };
    expect(block.needs).toBe("acknowledgement");
    expect(block.diagnosis?.what).toContain("nothing judged this diff");
    expect(block.diagnosis?.what).not.toContain("refused");
    expect(block.diagnosis?.raw).toContain("already in use");

    // Pushed on the way out, so the person being asked has the work to read.
    expect(did).toContain("git push HEAD:refs/heads/agent/7");
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

  /**
   * **`rounds` bound depth; `restarts` bound breadth**
   * ([0040](../../../doc/decisions/0040-rounds-bound-depth-restarts-bound-breadth.md)).
   *
   * Both arms of the same pass, because the interesting claim is the
   * *difference* between them and either alone would read as correct:
   *
   *   `restarts: 1`   the item is **released**, the arm is on the log, and the
   *                   next claim is an ordinary fresh pass
   *   `restarts: 0`   the item is **blocked** and asks, which is what it did
   *                   before this key existed — 0040 §4's default
   *
   * `--no-merge` is passed in both, as Lingtai passes it to itself, and it is
   * deliberately not a reason to refuse a restart: the flag says *do not merge
   * without me*, and a restart merges nothing. Excluding it would make this
   * branch unreachable on the one repository that has to prove it.
   */
  describe("when the rounds are spent and the review still refuses", () => {
    const spentPass = async (restarts: number) => {
      const store = memoryStore();
      const did: string[] = [];
      const said: string[] = [];
      const result = await once(
        {
          project,
          client: fakeGitHub(said, restartRecipe(restarts)),
          runtime: refusingRuntime,
          issue: 7,
          hookBinary: "/tmp/fake/lingtai-hook",
          prompt: "fix {{issue}}",
          merge: false,
          home: "/tmp/fake-home",
          store,
        },
        fakePorts(did, store),
      );
      return { result, store, did, said, item: await store.read(`wi-${PROJECT}-7`) };
    };

    it("releases the item for a fresh pass when the recipe buys one", async () => {
      const { result, item, did, said } = await spentPass(1);

      expect(result.ok).toBe(false);
      if (result.ok !== false) return;
      expect(result.stage).toBe("restart");

      // **Released and not blocked**, which is the whole of the change: a
      // question for a person sits in "Waiting on you" and a released item is
      // back in the queue, where the next pass claims it.
      const types = item.map((e) => e.type);
      expect(types).toContain("PassRestarted");
      expect(types).toContain("WorkItemReleased");
      expect(types).not.toContain("WorkItemBlocked");

      // Recorded *before* the release, which is the mechanism and not an
      // ordering preference: the fold has to carry the arm before anything can
      // claim the next one, or the ceiling counts one restart short for ever.
      expect(types.indexOf("PassRestarted")).toBeLessThan(types.indexOf("WorkItemReleased"));

      // The arm carries what refused it, because its run's stream is not read
      // by any later pass — so this is where a person asked after the *last*
      // restart finds out what the first approach was refused for.
      const arm = item.find((e) => e.type === "PassRestarted")!.data as {
        restart: number;
        of: number;
        action: string;
        branch: string;
        findings: { claim: string }[];
      };
      // **The arm's own ref, not the working branch.** `agent/7` is what the
      // next prompt names, so the arm after this one takes it over — and a
      // person shown every arm at the end would then be reading shas origin
      // dropped. `agent/7-restart-1` is written by this arm and by nothing
      // else, so the heading on that card stays fetchable.
      expect(arm).toMatchObject({
        restart: 1,
        of: 1,
        action: "review",
        branch: "agent/7-restart-1",
      });
      expect(arm.findings[0]!.claim).toBe("the approach cannot work");

      // **And both branches are on origin.** The only push in a pass is
      // after its gates pass, which a spent review never reaches, so these
      // commits were in a `--force --detach` worktree with no ref anywhere —
      // while `attempts.ts` tells the next agent `git fetch origin agent/7`,
      // which is the whole of the mechanism (0040 §2). One push, two refspecs:
      // the working branch moves to the newest arm and the arm's own ref
      // keeps this one. Pushed while the worktree still exists, which is the
      // only place those commits are.
      const push = "git push HEAD:refs/heads/agent/7 +HEAD:refs/heads/agent/7-restart-1";
      expect(did).toContain(push);
      expect(did.indexOf(push)).toBeLessThan(did.indexOf(`remove ${result.runId}`));

      // And the release says which arm, in the sentence that becomes both the
      // card's line and the next attempt's own history row.
      const reason = (item.find((e) => e.type === "WorkItemReleased")!.data as { reason: string })
        .reason;
      expect(reason).toContain("restart 1 of 1");
      expect(reason).toContain("approach is abandoned");

      // Back in the queue as far as GitHub is concerned, not waiting on anyone
      // — which is what makes the next claim possible at all: an issue left
      // reading `lingtai:working` is one a person has to go and fix by hand.
      expect(said.filter((l) => l.startsWith("labels #7"))).toEqual([
        "labels #7 bug,lingtai:working",
        "labels #7 bug",
      ]);
      expect(did).toContain(`remove ${result.runId}`);
    });

    /**
     * 0040 §4: the default is today's behaviour. One ticket of evidence does
     * not turn a new way to spend an agent on for every project, so with the
     * key left alone the pass stops and asks — and the card says what happened
     * and why nothing more was bought.
     */
    it("asks a person when the recipe buys none, and says which ceiling stopped it", async () => {
      const { result, item } = await spentPass(0);

      expect(result.ok).toBe("held");

      const types = item.map((e) => e.type);
      expect(types).toContain("WorkItemBlocked");
      expect(types).not.toContain("PassRestarted");

      // **Both ceilings in one sentence.** A card that named only the rounds
      // would report a ceiling a reader can see and hide the one they cannot.
      const blocked = item.find((e) => e.type === "WorkItemBlocked")!.data as {
        question: string;
        diagnosis: { done: string; raw: string | null } | null;
      };
      // **And not "two agents disagreed"** (`#197`): `rounds: 0` is the recipe
      // buying nobody to answer the reviewer, so exactly one agent looked at
      // this diff. The ceiling is still both ceilings' to name, below.
      expect(blocked.question).not.toContain("two agents disagreed");
      expect(blocked.question).toContain("buys no fix round");
      expect(blocked.question).not.toContain("restart");
      expect(blocked.diagnosis!.done).toContain("runtime.limits.rounds: 0");
      expect(blocked.diagnosis!.done).toContain("runtime.limits.restarts: 0");
      // And the findings are still the evidence, unframed — no headings, because
      // there is only one approach to tell apart.
      expect(blocked.diagnosis!.raw).toContain("deadlocks on the lock the first took");
      expect(blocked.diagnosis!.raw).not.toContain("## this approach");
    });
  });
});

/**
 * `env.refuseHosts` reaches the tripwire, which is the whole of `#51`.
 *
 * A field carried through the recipe and handed to nothing is `#89`'s shape,
 * and it would pass every test in `agent-env`: the tripwire works there with
 * whatever patterns it is given. This asserts the conductor gives it these.
 */
describe("runOnce hands the recipe's production hosts to the environment", () => {
  it("passes env.refuseHosts to resolveEnv, before anything is claimed", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const ports = fakePorts(did, store);
    let seen: readonly string[] | undefined;
    ports.agent.resolveEnv = (options) => {
      seen = options.patterns;
      return Effect.succeed({ values: {}, names: [], refusal: "refused here" }) as never;
    };

    const result = await once(
      {
        project,
        client: fakeGitHub([], RECIPE.replace("required: [],", "required: [], refuseHosts: [abcdefghijklmnopqrst],")),
        runtime,
        issue: 7,
        hookBinary: "/tmp/fake/lingtai-hook",
        prompt: "fix {{issue}}",
        merge: false,
        home: "/tmp/fake-home",
        store,
      },
      ports,
    );

    expect(result).toMatchObject({ ok: false, stage: "env" });
    // The recipe's added to the default, which a file the agent can edit must not remove.
    expect(seen).toEqual(["prod", "production", "abcdefghijklmnopqrst"]);
  });
});

/**
 * The same tripwire over what an **extension** declares, before the claim.
 *
 * `resolveEnv` checks the agent's values, after `deny`, so a denied production
 * value a `run:` extension declares used to pass stage `env` and first throw at
 * `gates.prepared` — past the claim and the worktree, as a defect mid-run.
 */
describe("runOnce refuses an extension's production value before anything is claimed", () => {
  it("stops at stage env when a run: extension declares a denied production host", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const ports = fakePorts(did, store);
    const prod = "postgresql://postgres:s3cr3t@db.eliwlauokdzgsqfgczkv.supabase.co:5432/postgres";
    ports.agent.resolveEnv = () =>
      Effect.succeed({
        values: {},
        merged: { PROD_DATABASE_URL: prod },
        names: [],
        missing: [],
        deferred: [],
        file: "/tmp/fake-home/env/demo.env",
        refusal: null,
      }) as never;

    const recipe = RECIPE.replace("required: [],", "required: [], deny: [PROD_DATABASE_URL], refuseHosts: [eliwlauokdzgsqfgczkv],").replace(
      "steps: {}",
      "steps:\n  prepared:\n    - name: migrate\n      run: pnpm migrate\n      env: [PROD_DATABASE_URL]",
    );
    const result = await once(
      {
        project,
        client: fakeGitHub([], recipe),
        runtime,
        issue: 7,
        hookBinary: "/tmp/fake/lingtai-hook",
        prompt: "fix {{issue}}",
        merge: false,
        home: "/tmp/fake-home",
        store,
      },
      ports,
    );

    expect(result).toMatchObject({ ok: false, stage: "env", workItemId: null });
    expect((result as { detail: string }).detail).toMatch(/PROD_DATABASE_URL looks like production.*"eliwlauokdzgsqfgczkv"/);
    expect((result as { detail: string }).detail).not.toContain("s3cr3t");
    // Nothing claimed, nothing provisioned.
    expect(did).toEqual([]);
    expect(await store.read(`wi-${PROJECT}-7`)).toEqual([]);
  });
});

/**
 * The governance rule, at the point where it bites: which recipe judges a
 * change is decided where the recipe is resolved.
 *
 * `packages/actions/unit/tamper-watch.test.ts` proves the watch holds when it is
 * in the recipe. Since 0046 §3 the recipe is this machine's file and nothing in
 * the repository is read for it, so this hands `runOnce` a repository whose
 * every ref carries a disarmed copy, a machine recipe that has the watch, and
 * the diff that deletes it — and the machine's is what holds.
 *
 * **Through the default read, not an injected one.** No `recipe` is passed:
 * the armed copy is a real `recipe.yml` under a `LINGTAI_HOME` this test owns,
 * so a `runOnce` whose default went back to reading the repository would be
 * handed the disarmed copy and merge.
 */
describe("runOnce judges a change by the machine's recipe, not by any file in the repository", () => {
  it("holds a diff that deletes the tamper watch, though the repository's own copy no longer has one", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const ports = fakePorts(did, store, true);
    const git = ports.repo.git;
    ports.repo.git = (...call: Parameters<typeof git>) =>
      call[0][0] === "diff" && call[0][1] === "--name-only"
        ? git(...call).pipe(Effect.as(".lingtai/config.yaml\npackages/actions/src/watch-gate.ts\n"))
        : git(...call);

    const armed = RECIPE.replace(
      "steps: {}",
      'steps:\n  proposed:\n    - name: tamper\n      watch: [".lingtai/config.yaml", "packages/actions/**"]\n      then: request-approval',
    );
    const client = {
      ...fakeGitHub([], RECIPE),
      fileAt: async (path: string) => (path !== ".lingtai/config.yaml" ? null : RECIPE),
    } as unknown as GitHubClient;

    // The machine's half: the recipe without `runtime`, and the agent named in
    // `config.yml` so nothing is asked what is signed in.
    const lingtaiHome = await mkdtemp(join(tmpdir(), "lingtai-home-"));
    await mkdir(join(lingtaiHome, PROJECT));
    await writeFile(join(lingtaiHome, PROJECT, "recipe.yml"), armed.replace(/^runtime:.*$/m, ""));
    await writeFile(join(lingtaiHome, "config.yml"), "runtime:\n  agent: claude-code\n  limits: { turns: 10, wall: 2m }\n");
    const saved = process.env["LINGTAI_HOME"];
    process.env["LINGTAI_HOME"] = lingtaiHome;

    const result = await Effect.runPromise(
      runOnce({
        project,
        client,
        runtime,
        issue: 7,
        hookBinary: "/tmp/fake/lingtai-hook",
        prompt: "fix {{issue}}",
        merge: true,
        home: "/tmp/fake-home",
        store,
      }).pipe(Effect.provide(withPorts(ports))),
    ).finally(async () => {
      if (saved === undefined) delete process.env["LINGTAI_HOME"];
      else process.env["LINGTAI_HOME"] = saved;
      await rm(lingtaiHome, { recursive: true, force: true });
    });

    if (result.ok === false) throw new Error(`stopped at ${result.stage}: ${result.detail}`);
    expect(result).toMatchObject({ ok: "held", gate: "proposed" });
    // Held by the machine's watch, which the repository's copy does not have.
    const asked = (await store.read(result.runId)).filter((e) => e.type === "ApprovalRequested");
    expect(asked.map((e) => e.data)).toMatchObject([{ gate: "proposed", action: "tamper" }]);
    expect(did).not.toContain("integrate");
  });
});

/**
 * **The agent the recipe resolved to is the one that runs** (#180). A machine
 * file naming `codex` resolves, `lingtai doctor` prints it, and a conductor
 * handed `claude-code` must not run that on the ticket and record claude-code.
 */
describe("runOnce runs the agent the recipe names, or nothing", () => {
  it("refuses before the claim when runtime.agent is not the runtime it was handed", async () => {
    const store = memoryStore();
    const did: string[] = [];
    const codex = RECIPE.replace("agent: claude-code", "agent: codex");

    const result = await once(
      {
        project,
        client: fakeGitHub([], codex),
        runtime,
        issue: 7,
        hookBinary: "/tmp/fake/lingtai-hook",
        prompt: "fix {{issue}}",
        home: "/tmp/fake-home",
        store,
      },
      fakePorts(did, store),
    );

    expect(result).toMatchObject({ ok: false, stage: "recipe", workItemId: null });
    expect((result as { detail: string }).detail).toContain("runtime.agent is codex");
    expect((result as { detail: string }).detail).toContain("this conductor runs claude-code");
    expect(did).toEqual([]);
    expect(await store.read(`wi-${PROJECT}-7`)).toEqual([]);
  });
});
