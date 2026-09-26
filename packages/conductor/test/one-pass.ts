/**
 * A whole pass against fakes — the scaffolding, and no test in it.
 *
 * **It is its own module so that the claims built on it run in the `build`
 * gate.** The old engine's fakes test said this itself and named the way:
 * it was *mostly unit and reached out once* — one `describe` writing a
 * `recipe.yml` into a temporary `LINGTAI_HOME`, which is the filesystem and so
 * is integration ([0060](../../../doc/decisions/0060-the-gate-runs-unit-tests.md)
 * §1) — and #225 moved the whole file for that one `describe`. Nineteen
 * assertions about a pass therefore sat in the half nobody runs while doing a
 * ticket, which `#251` is: every claim it makes about the wall would have been
 * guarded by nothing the gate executes.
 *
 * So the fixtures are here, in the `test/` a package keeps for what is not
 * itself a test, and the two halves import them — `unit/` for everything that
 * needs no world, `integration/` for the one that needs a `$HOME`.
 *
 * Nothing here imports `pg`, `@lingtai/repo` or `@lingtai/agent`, and nothing
 * here opens a connection, spawns a process or touches a disk. That is the
 * property that makes the unit half unit, and it is the property to check
 * before adding to this file.
 *
 * What the tests on top of it assert is the *decision*: which events a held run
 * appends, in order, and that the worktree is removed on the way out. Not the
 * git, not the socket — those have their own tests, in the packages that own
 * them.
 */
import type { Envelope, ToAppend } from "@lingtai/domain";
import type { EventStore } from "@lingtai/event-store";
import type { GitHubClient, Issue } from "@lingtai/github";
import type { Runtime } from "@lingtai/agent";
import type { ProjectState } from "@lingtai/domain";
import { Effect, Layer } from "effect";
import { AgentHost, Repo, type RunPorts } from "../src/ports.ts";
import { runOnce } from "../src/conduct.ts";
import { resolveRecipe } from "@lingtai/recipe";

/**
 * The two tags, from the plain shape.
 *
 * `runOnce` asks for `Repo` and `AgentHost` rather than taking a `RunPorts`
 * parameter ([0026](../../../doc/decisions/0026-the-conversion-past-the-seam.md)),
 * so a test provides them the way a host does. `RunPorts` survives as exactly
 * this: the shape a `Layer` is built from.
 */
export const withPorts = (ports: RunPorts) =>
  Layer.merge(Layer.succeed(Repo, ports.repo), Layer.succeed(AgentHost, ports.agent));

export const once = (options: Parameters<typeof runOnce>[0], ports: RunPorts) =>
  Effect.runPromise(
    runOnce({
      // The recipe through the fake GitHub's `fileAt`, so each test keeps the
      // recipe it wrote. Where a real run reads it from is `local.test.ts`'s.
      recipe: () =>
        resolveRecipe((p, r) => options.client.fileAt(p, r), options.project.base ?? "main"),
      ...options,
    }).pipe(Effect.provide(withPorts(ports))),
  );

export const PROJECT = "purecheck";

/**
 * The log, in a Map.
 *
 * Enough of `EventStore` to be one: append refuses on a stale version, exactly
 * as `UNIQUE (stream_id, version)` does, because the conductor's whole mutual
 * exclusion rests on that refusal and a fake that always says yes would test
 * the opposite of what runs.
 */
/** The fake store's own map, for the fakes that need to see it. */
export function streams(store: EventStore): Map<string, Envelope[]> {
  return (store as EventStore & { streams: Map<string, Envelope[]> }).streams;
}

export function memoryStore(): EventStore & { streams: Map<string, Envelope[]> } {
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

export const RECIPE = `
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
export const restartRecipe = (restarts: number) => `
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
export const REVIEWED = `
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

/**
 * A person declared at `merge`, and nothing else asking — which is the recipe
 * this repository has had since the day it was self-hosted.
 *
 * **The point of it is that no flag is passed.** `#58` merged two changes into
 * `main` with nobody's approval because `merge:` was resolved, printed by
 * `lingtai add` and drawn on the board without ever being built into a pipeline,
 * and the reason that stayed hidden for four days is that `--no-merge` was the
 * only thing that had ever held a run: every test held its run with the flag, and
 * the daemon does not pass it.
 */
export const HUMAN_AT_MERGE = `
version: 2
repo: { base: main, submodules: false }
source: { kinds: [bug], exclude: [] }
env: { required: [], plantAt: .env.local }
steps:
  merge:
    - name: approval
      human: "Merge this? It is Lingtai's own code."
runtime: { agent: claude-code, limits: { turns: 10, wall: 2m } }
`;

export const issue: Issue = {
  number: 7,
  title: "a race in the importer",
  body: "fix it",
  labels: [{ name: "bug", color: "#d73a4a" }],
  state: "open",
  url: "https://example.invalid/7",
  dependencies: { blockedBy: 0, totalBlockedBy: 0 },
  assignees: [],
};

export const project: ProjectState = {
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
export function fakeGitHub(said: string[], recipe = RECIPE): GitHubClient {
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
export const runtime: Runtime = {
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
export const refusingRuntime: Runtime = {
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
export function reviewerThatCrashes(tried: { n: number }): Runtime {
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
export const quotaRuntime: Runtime = {
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
export const reviewerAtTheWall: Runtime = {
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
export function fakePorts(did: string[], store: EventStore, merges = false): RunPorts {
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
      // The `close` this records is the one the old engine used to make in a
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
      /**
       * The step agents' settings file, as a path and no file.
       *
       * The real one `mkdir -p`s and writes under the `home` it is handed, so
       * while the conductor called it directly every pass that reached `review`
       * wrote `<home>/runs/<runId>/<runId>.review.settings.json` to a real disk
       * — from the unit half, into a `/tmp/fake-home` nothing ever cleans, which
       * is the filesystem and so is integration (0060 §1). It is a port now, and
       * this is the fake: the path is what the reviewer is handed, and what the
       * tests assert is that it was asked for.
       */
      unhookedSettings: (o) =>
        Effect.sync(() => {
          did.push(`unhookedSettings ${o.label}`);
          return `/tmp/fake/${o.runId}.${o.label}.settings.json`;
        }),
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
