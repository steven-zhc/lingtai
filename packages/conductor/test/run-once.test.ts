/**
 * `lingtai run --once`, end to end.
 *
 * Everything real except GitHub: a bare repository in a temp directory as the
 * remote, the compiled `lingtai-hook` on a real unix socket, real gates running real
 * commands, the real integrator taking a real advisory lock, and the real board
 * projection at the end. The agent is a shell script that makes a commit,
 * because what is under test is the *wiring* — the order of the steps and what
 * each one records — and not the model.
 *
 * The one piece that is a stand-in is the GitHub client, because there is no
 * GitHub App yet. #17's exit criterion is a real `nextloom-ai-admin` issue
 * merged into `develop`, and that needs an App created by a person. This is as
 * close as it is possible to get without one, and it is close: discovery,
 * claim, worktree, hook, run, diff, gates, merge and board, all genuinely
 * executed.
 */
import { integrationStream, reduceWorkItem, workItemStream } from "@lingtai/domain";
import { createProjectionRunner, readTasks, taskViewProjection } from "@lingtai/projector";
import { directDatabaseUrl } from "@lingtai/env";
import type { GitHubClient, Issue } from "@lingtai/github";
import { PROMPT_ELIDED, createClaudeCodeRuntime } from "@lingtai/agent";
import { createDb, createEventStore, type Db, type EventStore } from "@lingtai/event-store";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  PortsLive,
  appendEndActions,
  approve,
  reject,
  renderPrompt,
  requeue,
  runOnce,
  runQueue,
  waive,
} from "../src/index.ts";
import type { GateAction, Recipe } from "@lingtai/recipe";
import type { ProjectState } from "@lingtai/domain";

const exec = promisify(execFile);

/**
 * The host's edge, in a test.
 *
 * `runOnce` and `runQueue` are `Effect`s that ask for `Repo` and `AgentHost`
 * ([0026](../../../doc/decisions/0026-the-conversion-past-the-seam.md)). This
 * file wants the real world, so it provides the real layer and runs once at the
 * edge — the same two lines `apps/cli/src/run.ts` uses, which is the point of
 * them being two lines.
 */
const once = (options: Parameters<typeof runOnce>[0]) =>
  Effect.runPromise(runOnce(options).pipe(Effect.provide(PortsLive)));
const queue = (options: Parameters<typeof runQueue>[0]) =>
  Effect.runPromise(runQueue(options).pipe(Effect.provide(PortsLive)));
const here = dirname(fileURLToPath(import.meta.url));
const authored = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};
const g = (args: string[], cwd: string) =>
  exec("git", args, { cwd, env: { ...process.env, ...authored } });

const PROJECT = `esctest${crypto.randomUUID().slice(0, 6)}`;
const created = new Set<string>();

let root: string;
let originPath: string;
let work: string;
let home: string;
let hookBinary: string;
let client: Db;
let store: EventStore;

const RECIPE = `
version: 1
repo: { base: develop, submodules: false }
source: { kinds: [bug], exclude: [blocked] }
env: { required: [ESC_TEST_VALUE], plantAt: .env.local }
gates:
  proposed:
    - { name: build, run: "test -f src/fix.ts", timeout: 2m }
runtime: { agent: claude-code, limits: { turns: 10, wall: 2m } }
`;

const project: ProjectState = {
  project: PROJECT,
  owner: "steven-zhc",
  // Recorded at onboarding. The fake client's default branch is `develop` too,
  // so this test would pass either way — which is exactly why the real repo
  // (whose default is a feature branch) is the one that found the bug.
  base: "develop",
  configHash: "seeded",
  fromSha: "0".repeat(40),
  version: 1,
  lastSeq: null,
};

const issue2 = (n: number): Issue => ({ ...issue, number: n });

const issue: Issue = {
  number: 117,
  title: "a race in the importer",
  body: "fix it",
  labels: [{ name: "bug", color: "#d73a4a" }],
  state: "open",
  url: "https://example.invalid/117",
};

/** The `end` point, configured: close the issue when the item lands. */
const CLOSING_RECIPE = RECIPE.replace(
  "runtime: {",
  `  end:
    - { name: "close the ticket", when: landed, close: true }
runtime: {`,
);

/**
 * A person at `merge`, declared in the recipe and asked for by nothing else.
 *
 * Lingtai's own recipe has had exactly this since the day it was self-hosted.
 */
const HUMAN_MERGE_RECIPE = RECIPE.replace(
  "runtime: {",
  `  merge:
    - { name: approval, human: "Merge this? It is Lingtai's own code." }
runtime: {`,
);

/** A recipe whose only gate refuses, whatever the agent did. */
const REFUSING_RECIPE = RECIPE.replace(
  'run: "test -f src/fix.ts"',
  'run: "echo the build is broken; exit 1"',
);

/**
 * The same, for a project that has said it does not repair.
 *
 * `repair.on` defaults to true
 * ([0025](../../../doc/decisions/0025-a-failure-buys-one-agent.md) §2), so this
 * is the recipe that gets the *other* outcome of a failure — a block carrying
 * the reason no agent was bought.
 */
const NO_REPAIR_RECIPE = REFUSING_RECIPE.replace(
  "runtime: {",
  `repair: { on: false }
runtime: {`,
);

/** GitHub, minus GitHub. Serves the issue and the recipe from the base branch. */
function fakeClient(over: Partial<GitHubClient> & { recipe?: string } = {}): GitHubClient {
  const { recipe = RECIPE, ...rest } = over;
  return {
    owner: "steven-zhc",
    repo: PROJECT,
    installation: { id: 1, permissions: {}, account: "steven-zhc", repositorySelection: "selected" },
    request: async () => {
      throw new Error("not used");
    },
    // Throws rather than returning a dummy: these tests clone from a local path
    // and must never authenticate. If something starts asking for a token, the
    // test should say so loudly rather than quietly succeed with a fake one.
    token: async () => {
      throw new Error("not used");
    },
    defaultBranch: async () => "develop",
    // The governance rule: the recipe comes from the base branch, and this
    // client will not serve it for any other ref.
    fileAt: async (path, ref) =>
      path === ".lingtai/config.yaml" && ref === "develop" ? recipe : null,
    refSha: async () => "0".repeat(40),
    listOpenIssues: async () => [issue],
    // These used to throw. The conductor never wrote to GitHub — the outbox
    // did — so a write from here meant a bug, and the fake said so. 0022
    // deletes the outbox and makes the conductor tell GitHub inline, so the
    // guard would now fail the thing it was guarding. They record instead.
    comment: async () => ({ id: 909 }),
    closeIssue: async () => {},
    setLabels: async () => {},
    getIssue: async () => issue,
    ...rest,
  };
}

/** An "agent" that edits a file and commits, exactly as a real one would. */
async function agentThat(body: string): Promise<string> {
  const path = join(root, `agent-${crypto.randomUUID().slice(0, 8)}.sh`);
  await writeFile(
    path,
    `#!/bin/sh
set -e
${body}
echo '{"is_error":false,"num_turns":7,"duration_ms":1234,"total_cost_usd":0.42}'
`,
  );
  await chmod(path, 0o755);
  return path;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "lingtai-runonce-"));
  originPath = join(root, "origin.git");
  work = join(root, "work");
  home = join(root, "home");

  // The value the fixture recipe requires, in the **project's own file**.
  //
  // It used to be `process.env["ESC_TEST_VALUE"] = "planted"` inside the first
  // test, and `#60` is why that stopped working: the shell is no longer a layer.
  // An agent's environment is the two files merged — the machine's and the
  // project's — so the operator's exports (`AWS_*`, npm tokens, whatever is set
  // in the terminal a command was typed into) never reach a run. Writing it
  // here is what a real operator does.
  await mkdir(join(home, "env"), { recursive: true });
  // Both projects: the scheduler suite runs under its own name, and an env file
  // is per project by design — that is the whole of layer 3.
  for (const name of [PROJECT, `${PROJECT}sched`]) {
    await writeFile(join(home, "env", `${name}.env`), 'ESC_TEST_VALUE="planted"\n');
  }

  await exec("git", ["init", "-q", "-b", "develop", work]);
  await writeFile(join(work, "README.md"), "hello\n");
  await g(["add", "-A"], work);
  await g(["commit", "-qm", "first"], work);
  await exec("git", ["clone", "-q", "--bare", work, originPath]);

  hookBinary = join(root, "lingtai-hook");
  await exec("bun", ["build", "--compile", "--outfile", hookBinary, resolve(here, "../../hook/src/lingtai-hook.ts")]);

  client = createDb();
  store = createEventStore(client);

  created.add(workItemStream(PROJECT, 117));
  created.add(integrationStream(PROJECT, "develop"));
}, 240_000);

afterAll(async () => {
  await client.close();
  const c = new pg.Client({ connectionString: directDatabaseUrl() });
  await c.connect();
  try {
    await c.query("alter table events disable rule lingtai_events_no_delete");
    await c.query("delete from events where stream_id = any($1::text[])", [[...created]]);
    await c.query("delete from events where stream_id like $1", [`run-%`]);
  } finally {
    await c.query("alter table events enable rule lingtai_events_no_delete");
    await c.query("delete from board where project = $1", [PROJECT]);
    await c.query("delete from board_project where project = $1", [PROJECT]);
    await c.query("delete from checkpoints where name = 'board'");
    await c.end();
  }
  await rm(root, { recursive: true, force: true });
});

const options = (agent: string) => ({
  project,
  client: fakeClient(),
  runtime: createClaudeCodeRuntime({ binary: agent }),
  issue: 117,
  hookBinary,
  prompt: "fix the race",
  home,
  store,
  remote: originPath,
  gitEnv: { ...process.env, ...authored },
});

describe("runOnce", () => {
  it("takes one issue from discovery to a merge, and records the whole story", async () => {
    // The prompt exactly as the agent was handed it — `claude -p <prompt>`, so
    // `$2`. Captured outside the worktree, which is deleted when the run ends.
    const dispatchedTo = join(root, "prompt-117.txt");
    const agent = await agentThat(`
printf '%s' "$2" > ${dispatchedTo}
mkdir -p src
echo 'export const fix = 1;' > src/fix.ts
git add -A
git -c user.name=agent -c user.email=a@example.invalid commit -qm 'fix the race'
`);

    const lines: string[] = [];
    const result = await once({ ...options(agent), log: (l) => lines.push(l) });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    created.add(result.runId);

    // It really landed on the base branch at the remote.
    const log = await exec("git", ["log", "--oneline", "develop"], { cwd: originPath });
    expect(log.stdout).toContain("fix the race");

    // ---- the event stream reads as a coherent story with no gaps ----
    const wi = (await store.read(workItemId())).map((e) => e.type);
    // `IssueUpdated` after each state change: the run tells GitHub as it goes
    // and writes down that it did (0022). The claim sets `lingtai:working`;
    // the landing clears it.
    expect(wi).toEqual(["WorkItemClaimed", "IssueUpdated", "WorkItemLanded", "IssueUpdated"]);

    const run = (await store.read(result.runId)).map((e) => e.type);
    expect(run.slice(0, 3)).toEqual(["RunStarted", "GatesResolved", "RunFinished"]);
    expect(run).toContain("RunProducedDiff");
    expect(run).toContain("RunProposedCompletion");
    expect(run).toContain("GateRequested");
    expect(run).toContain("GatePassed");

    const lane = (await store.read(integrationStream(PROJECT, "develop"))).map((e) => e.type);
    expect(lane).toEqual(["IntegrationAttempted", "IntegrationSucceeded"]);

    // The receipt survived the round trip.
    const finished = (await store.read(result.runId)).find((e) => e.type === "RunFinished")!;
    expect(finished.data).toMatchObject({ turns: 7, costUsd: 0.42 });

    // The agent could see the allowlisted value and nothing else.
    expect(lines.join("\n")).toContain("worktree");

    // ---- how it was invoked, which the log used only to hint at ----
    //
    // `RunStarted` said `runtime: "claude-code"` and stopped, so "what command
    // did we run" had no answer (#88). It now carries the argv the adapter
    // built, the tier that was matched before dispatch, and the limits as
    // applied — `wall: 2m` resolved to milliseconds, which nothing else records.
    const started = (await store.read(result.runId)).find((e) => e.type === "RunStarted")!;
    const { invocation } = started.data as {
      invocation: {
        command: string;
        args: string[];
        tier: string;
        limits: { turns: number; wallMs: number };
      } | null;
    };

    expect(invocation, "RunStarted recorded no invocation").not.toBeNull();
    expect(invocation!.command).toBe(agent);
    expect(invocation!.args).toContain("--permission-mode");
    expect(invocation!.args).toContain("bypassPermissions");
    // The document itself is on this same stream as `RunPrompted`, not twice.
    expect(invocation!.args).toContain(PROMPT_ELIDED);
    expect(invocation!.tier).toBe("guarded");
    expect(invocation!.limits).toEqual({ turns: 10, wallMs: 120_000 });

    /**
     * The prompt carries no environment value, asserted rather than assumed.
     *
     * [0021](../../../doc/decisions/0021-the-recipe-decides-the-environment.md):
     * values reach an agent as a planted **file**, never through the prompt. So
     * this should already hold — and it is a test rather than an assumption
     * because `RunPrompted` now carries the prompt text (#88), which puts it in
     * front of anyone who opens a task page. `ESC_TEST_VALUE=planted` is the one
     * value this project's recipe requires, and the fixture writes it into the
     * project's own env file exactly as an operator would.
     */
    const dispatched = await readFile(dispatchedTo, "utf8");
    expect(dispatched).toContain("fix the race");
    expect(dispatched).not.toContain("planted");
  }, 240_000);

  it("shows the landed card on the board with its receipt", async () => {
    const runner = createProjectionRunner({ projection: taskViewProjection, store });
    try {
      await runner.start();
      const cards = await readTasks({ project: PROJECT, retentionDays: 3650 });
      const card = cards.find((c) => c.issue === "117");

      expect(card, "the work item never reached the board").toBeDefined();
      expect(card!.state).toBe("landed");
      expect(card!.note).toBeTruthy();
      expect(card!.turns).toBe(7);
      expect(card!.costUsd).toBe(0.42);
      // The count, not the verdicts: evidence is read from the stream when
      // somebody opens the task.
      expect(card!.gatesPassed).toBeGreaterThan(0);
    } finally {
      await runner.close();
    }
  }, 120_000);

  /**
   * A red gate is the managed repository's failure, so it buys one agent.
   *
   * The old assertion here — claim, block, and stop — is what `#84` is about:
   * an item whose merge lane refused sat in "Waiting on you" with a line of git
   * output and no move. Since 0025 the failure has an outcome instead: it is
   * recorded, the item goes back to the queue, and the next claim is the repair
   * that was bought. Nothing merges either way, which is the part that has not
   * changed.
   */
  it("buys one agent when a gate refuses, and still does not merge", async () => {
    // A second issue, so the first one's history stays intact.
    const other = { ...issue, number: 118 };
    created.add(workItemStream(PROJECT, 118));

    // A perfectly ordinary change, against a recipe whose gate refuses. The
    // gate has to be the thing that fails rather than the file state: by now
    // `develop` contains what the first run merged, so a gate looking for that
    // file would pass — which is exactly how this test failed the first time.
    const agent = await agentThat(`
echo 'a change like any other' > CHANGELOG.md
git add -A
git -c user.name=agent -c user.email=a@example.invalid commit -qm 'wrong change'
`);

    const result = await once({
      ...options(agent),
      issue: 118,
      client: fakeClient({
        recipe: REFUSING_RECIPE,
        getIssue: async () => other,
        listOpenIssues: async () => [other],
      }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    created.add(result.runId!);
    expect(result.stage).toBe("integrate");
    expect(result.detail).toContain("gate-failed");
    // The evidence travels with the refusal: the board shows why, not that.
    expect(result.detail).toContain("the build is broken");

    // Recorded, *then* released — and the order is the mechanism, not a
    // preference: between the two the fold carries a pending repair, and the
    // next claim is that repair.
    const events = await store.read(workItemStream(PROJECT, 118));
    expect(events.map((e) => e.type)).toEqual([
      "WorkItemClaimed",
      "IssueUpdated",
      "RepairRequested",
      "WorkItemReleased",
      "IssueUpdated",
    ]);

    const bought = events.find((e) => e.type === "RepairRequested")!;
    expect(bought.data).toMatchObject({ reason: "gate-failed", attempt: 1 });
    // The refusal verbatim, because that is what the next attempt's prompt is
    // given. A summary that hid the gate's output would make the repair a
    // re-run with extra steps.
    expect((bought.data as { detail: string }).detail).toContain("the build is broken");

    // The item is queueable again, and the one thing it must not be is merged.
    expect(reduceWorkItem(events).lifecycle.status).toBe("backlog");
    expect(reduceWorkItem(events).pendingRepair?.fingerprint).toHaveLength(12);

    const log = await exec("git", ["log", "--oneline", "develop"], { cwd: originPath });
    expect(log.stdout).not.toContain("wrong change");
  }, 240_000);

  /**
   * The repair itself, and the two things that make it one.
   *
   * It runs straight after the test above, on the same work item, because that
   * is the whole mechanism: the release put `#118` back in the queue carrying a
   * pending repair, and the next claim *is* it. Nothing nominates it as such.
   *
   * **Told what went wrong** — the previous refusal reaches the prompt, which
   * is the difference between a repair and a re-run at the same price.
   *
   * **Ends by asking** — `ApprovalRequested` on the head it produced, from a
   * recipe that declares nothing at `merge` and without `--no-merge`. This is
   * the requirement the two stuck items prove was missing: fixing the branch is
   * not enough, because the run whose approval was consumed is still `gating`
   * and nothing re-offers the decision.
   */
  it("tells the repair what went wrong, and ends it by asking for approval", async () => {
    const other = { ...issue, number: 118 };
    // The prompt the agent was handed, written out so the test can read it.
    // `-p <prompt>` is argv 2; see `claude-code.ts`.
    const seen = join(root, "repair-prompt.txt");
    const agent = await agentThat(`
printf '%s' "$2" > ${seen}
mkdir -p src
echo 'export const repaired = 1;' > src/repaired.ts
git add -A
git -c user.name=agent -c user.email=a@example.invalid commit -qm 'the repair'
`);

    const result = await once({
      ...options(agent),
      issue: 118,
      // A recipe whose gate passes now. The failure is behind it; what is under
      // test is what the repair is told and how it ends.
      client: fakeClient({ getIssue: async () => other, listOpenIssues: async () => [other] }),
    });

    expect(result.ok, JSON.stringify(result)).toBe("held");
    if (result.ok !== "held") return;
    created.add(result.runId);

    // The template here names no `{{failure}}` slot, which is the case that
    // must not lose it: a repair whose failure never reached the agent is a
    // re-run at the same price.
    const prompt = await readFile(seen, "utf8");
    expect(prompt).toContain("fix the race");
    expect(prompt).toContain("this one is the repair");
    expect(prompt).toContain("gate-failed");
    // Verbatim, not summarised: the raw failure has to stay reachable.
    expect(prompt).toContain("the build is broken");

    // The approval is bound to the commit the repair produced, so a person is
    // approving *this* diff and a force-push invalidates it by arithmetic.
    const run = await store.read(result.runId);
    const asked = run.find((e) => e.type === "ApprovalRequested");
    expect(asked, "a repair that does not ask has not repaired anything").toBeDefined();
    expect(asked!.data).toMatchObject({ gate: "merge", action: "repair", onSha: result.headSha });
    expect((asked!.data as { question: string }).question).toContain("A repair for gate-failed");

    // And it did not merge itself. The person approves the diff.
    const log = await exec("git", ["log", "--oneline", "develop"], { cwd: originPath });
    expect(log.stdout).not.toContain("the repair");
  }, 240_000);

  /**
   * The other outcome, and the one that must never be an absence.
   *
   * A project that says it does not repair still has to end up somewhere a
   * person can act. So the block carries the reason no agent was bought —
   * `#84`'s *"the card says so and offers whatever the remaining move is,
   * rather than a control that refuses"*.
   */
  it("blocks with the typed reason, and says why no agent was bought", async () => {
    const other = { ...issue, number: 134 };
    created.add(workItemStream(PROJECT, 134));

    const agent = await agentThat(`
echo 'a change like any other' > NOTES.md
git add -A
git -c user.name=agent -c user.email=a@example.invalid commit -qm 'unrepaired change'
`);

    const result = await once({
      ...options(agent),
      issue: 134,
      client: fakeClient({
        recipe: NO_REPAIR_RECIPE,
        getIssue: async () => other,
        listOpenIssues: async () => [other],
      }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    created.add(result.runId!);
    expect(result.stage).toBe("integrate");

    // Blocked with a question, not silently dropped — the board's "Waiting on
    // you" column is where a refusal goes.
    //
    // Three `IssueUpdated`: the claim's `lingtai:working`, then the question as
    // a comment, then `lingtai:waiting` replacing `working`. The third is
    // `#71` — for the whole life of the outbox a blocked item kept `working`
    // on GitHub while the board showed it waiting on a person.
    const events = await store.read(workItemStream(PROJECT, 134));
    expect(events.map((e) => e.type)).toEqual([
      "WorkItemClaimed",
      "IssueUpdated",
      "RepairDeclined",
      "WorkItemBlocked",
      "IssueUpdated",
      "IssueUpdated",
    ]);

    expect(events.find((e) => e.type === "RepairDeclined")!.data).toMatchObject({
      reason: "gate-failed",
      why: expect.stringContaining("repair.on: false"),
    });
    // And the sentence reaches the card, which is the whole point of recording
    // it: a question with no reason in it is the thing being replaced.
    const item = reduceWorkItem(events).lifecycle;
    expect(item.status).toBe("blocked");
    expect(item.status === "blocked" && item.question).toContain("no repair:");

    const log = await exec("git", ["log", "--oneline", "develop"], { cwd: originPath });
    expect(log.stdout).not.toContain("unrepaired change");
  }, 240_000);

  /**
   * `nextloom-ai-admin`'s default branch is a feature branch, not `develop`.
   * Falling back to it would read a run's rules from one branch while merging
   * into another — the confusion 0005 exists to prevent.
   */
  /**
   * The move that is left, on the item the test above blocked.
   *
   * `#84`'s last requirement: an item whose integration failed is never left in
   * a state with no path forward. The run is `gating` — its approval, if it had
   * one, is spent — so `approve()` refuses; putting it back in the queue is the
   * thing that can actually happen, and the next attempt is cut from a base
   * that has moved since.
   */
  it("puts a blocked item a repair could not help back in the queue", async () => {
    const before = await approve({
      project: PROJECT,
      issue: 134,
      base: "develop",
      client: fakeClient(),
      by: "human:test",
      store,
    });
    // The control the board used to offer here, refusing exactly as #84 says.
    expect(before.ok).toBe(false);
    expect(before.ok === false && before.reason).toBe("not-awaiting-approval");

    const back = await requeue({
      project: PROJECT,
      issue: 134,
      by: "human:test",
      note: "develop has moved; a fresh branch should merge",
      store,
    });
    expect(back.ok).toBe(true);
    expect(reduceWorkItem(await store.read(workItemStream(PROJECT, 134))).lifecycle.status).toBe(
      "backlog",
    );

    // And it refuses what is not a question: an item nobody is holding is not
    // one to hand back.
    const again = await requeue({
      project: PROJECT,
      issue: 134,
      by: "human:test",
      note: "again",
      store,
    });
    expect(again.ok).toBe(false);
    expect(again.detail).toContain("backlog");
  }, 60_000);

  it("reads the recipe from the recorded base, not the default branch", async () => {
    let askedFor: string[] = [];
    const result = await once({
      ...options(await agentThat("true")),
      issue: 121,
      client: fakeClient({
        // GitHub says the default is something else entirely.
        defaultBranch: async () => "feature/062-user-suggested-skills",
        fileAt: async (path, ref) => {
          askedFor.push(ref);
          return path === ".lingtai/config.yaml" && ref === "develop" ? RECIPE : null;
        },
      }),
    });

    // It asked `develop` — the recorded base — and never the default branch.
    expect(askedFor).toContain("develop");
    expect(askedFor).not.toContain("feature/062-user-suggested-skills");
    // It got past the recipe stage, which is all this case is about.
    if (!result.ok) expect(result.stage).not.toBe("recipe");
  }, 120_000);

  /**
   * The case the test above cannot reach: the recipe *is* read from the recorded
   * base, and says a different branch governs it.
   *
   * From there the run would be right about everything except the rules — it
   * cuts from `main` and merges into `main`, under gates read from `develop`.
   * Nothing downstream can see that, because `GatesResolved` is written from the
   * same file the run obeyed; so the assertion that matters is the *absence*:
   * the work item's stream is empty, which is the difference between a refusal
   * and an agent that has already been started and paid for.
   */
  it("refuses when the recipe's own repo.base is a different branch, and claims nothing", async () => {
    created.add(workItemStream(PROJECT, 122));
    const other = issue2(122);

    const result = await once({
      ...options(await agentThat("true")),
      issue: 122,
      client: fakeClient({
        recipe: RECIPE.replace("base: develop", "base: main"),
        getIssue: async () => other,
        listOpenIssues: async () => [other],
      }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Alongside `env.required`, before anything is claimed — so there is no run
    // to name either.
    expect(result.stage).toBe("recipe");
    expect(result.workItemId).toBeNull();
    expect(result.runId).toBeNull();
    // Both branches, and the exact command that settles which one is meant.
    expect(result.detail).toContain("recipe read from develop declares repo.base: main");
    expect(result.detail).toContain(`lingtai add steven-zhc/${PROJECT} --base main`);

    // The whole point: nothing was claimed, so nothing was started and nothing
    // has to be released.
    expect(await store.read(workItemStream(PROJECT, 122))).toEqual([]);
  }, 120_000);

  /**
   * The point of the `prepared` point, stated as a test: whatever runs there,
   * the agent is looking at afterwards. Before it existed the agent got a
   * worktree with no node_modules and could not run the repository's own tests
   * — it wrote blind, and nothing said so until a gate failed at the very end.
   *
   * This used to be a `prepare:` section of its own, with three events nothing
   * else had (ADR 0016: one mechanism per job). It is an action at a gate point
   * now, and the assertions moved with it: `GatePassed` at `prepared`, not
   * `PreparationPassed`.
   *
   * Here the action writes a file and the agent refuses unless it is there.
   */
  it("runs the prepared point before the agent, so the agent sees a worktree that works", async () => {
    const recipe = RECIPE.replace(
      "gates:",
      'gates:\n  prepared:\n    - { name: install, run: "echo ready > .prepared", timeout: 1m }',
    );
    const agent = await agentThat(`
test -f .prepared || { echo "the prepared point did not run before me"; exit 1; }
mkdir -p src && echo "export const x = 1;" > src/fix.ts
git add -A && git commit -q -m "fix the race"
`);

    const result = await once({
      ...options(agent),
      issue: 122,
      client: fakeClient({ recipe, getIssue: async () => ({ ...issue, number: 122 }) }),
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);

    const events = await store.read(result.runId!);
    const types = events.map((e) => e.type);
    const passedPrepared = events.findIndex(
      (e) => e.type === "GatePassed" && (e.data as { gate?: string }).gate === "prepared",
    );
    // Ordering is the assertion. The point finishes before the run begins.
    expect(passedPrepared).toBeGreaterThanOrEqual(0);
    expect(passedPrepared).toBeLessThan(types.indexOf("RunStarted"));
  }, 180_000);

  it("refuses at the prepared point without starting the agent, and says which action", async () => {
    const recipe = RECIPE.replace(
      "gates:",
      'gates:\n  prepared:\n    - { name: install, run: "echo could not resolve dependency; exit 1", timeout: 1m }',
    );
    // If this ever runs, the test fails loudly rather than quietly passing.
    const agent = await agentThat(`echo "the agent must not have started"; exit 1`);

    const result = await once({
      ...options(agent),
      issue: 123,
      client: fakeClient({ recipe, getIssue: async () => ({ ...issue, number: 123 }) }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe("prepare");
    // The log tail, not just "it failed". A card has to be workable without
    // leaving it.
    expect(result.detail).toContain("could not resolve dependency");

    const events = (await store.read(result.runId!)).map((e) => e.type);
    expect(events).toContain("GateFailed");
    // The whole cost argument: nothing expensive happened.
    expect(events).not.toContain("RunStarted");

    // And the work item goes back rather than sitting claimed by a run that is
    // over — the same rule every other refusal follows.
    const item = await store.read(workItemStream(PROJECT, 123));
    expect(item.map((e) => e.type)).toContain("WorkItemReleased");
  }, 180_000);

  /**
   * The flag, on a recipe that declares nothing at `merge`.
   *
   * It is how rung 2 of the ladder runs at all, and it stays a hold of its own
   * now that the point runs: a project with an empty `merge` still stops when
   * an operator asks it to, and asks in the same vocabulary a configured action
   * would.
   */
  it("holds after the gates instead of merging, and asks for approval", async () => {
    // Unique content. `develop` is shared across these tests and an earlier one
    // merges `src/fix.ts`; writing the same bytes again produces no commit, and
    // the run then fails at `diff` for a reason that has nothing to do with
    // holding.
    const agent = await agentThat(`
mkdir -p src && echo "export const held = 124;" > src/fix.ts
git add -A && git commit -q -m "fix the race"
`);
    const before = await g(["rev-parse", "develop"], originPath);

    const result = await once({
      ...options(agent),
      issue: 124,
      merge: false,
      client: fakeClient({ getIssue: async () => ({ ...issue, number: 124 }) }),
    });

    expect(result.ok).toBe("held");
    if (result.ok !== "held") return;

    // Nothing was written to the base branch. That is the entire promise.
    expect((await g(["rev-parse", "develop"], originPath)).stdout).toBe(before.stdout);

    const events = (await store.read(result.runId)).map((e) => e.type);
    // The gates ran and their verdicts stand — a hold is not a skip.
    expect(events).toContain("GatePassed");
    // And it asked, in the vocabulary the human gate will use, rather than
    // inventing a second one.
    expect(events).toContain("ApprovalRequested");
    expect(events).not.toContain("IntegrationAttempted");

    // "Waiting on you", not back in the queue where another run could claim it
    // and throw the question away.
    const held = await store.read(result.workItemId);
    const item = held.map((e) => e.type);
    expect(item).toContain("WorkItemBlocked");
    expect(item).not.toContain("WorkItemReleased");

    // And the block says what kind of hold it is and what to do about it (#83).
    // This one is the good kind: a decision that is genuinely a person's, on a
    // green run — so `approve` is recommended, which is what makes it the
    // board's primary control rather than one option among three.
    const block = held.find((e) => e.type === "WorkItemBlocked")!.data as {
      needs: string | null;
      diagnosis: { what: string; recommendation: { action: string } | null } | null;
    };
    expect(block.needs).toBe("judgement");
    expect(block.diagnosis?.what).toContain("every gate passed");
    expect(block.diagnosis?.recommendation?.action).toBe("approve");

    // ---- and then approving it merges the thing that was looked at ---------
    const approved = await approve({
      project: PROJECT,
      issue: 124,
      base: "develop",
      client: fakeClient({ refSha: async () => result.headSha }),
      by: "human:test",
      store,
      home,
      gitEnv: { ...process.env, ...authored },
    });

    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect((await g(["rev-parse", "develop"], originPath)).stdout).not.toBe(before.stdout);
  }, 180_000);

  /**
   * #58, as an assertion. The recipe put a person at `merge`, `lingtai add`
   * printed the point, `GatesResolved` recorded it and the board drew it — and
   * the point had never been built into a pipeline, so two changes merged into
   * `main` with nobody's approval.
   *
   * **Without `--no-merge`, deliberately.** That flag was the only thing that
   * ever held a run, which is exactly how the gap stayed hidden: the first
   * self-hosted run was held by hand, and the daemon does not pass it.
   */
  it("holds at a human action at the merge point, with no --no-merge anywhere", async () => {
    created.add(workItemStream(PROJECT, 127));
    const agent = await agentThat(`
mkdir -p src && echo "export const held = 127;" > src/fix.ts
git add -A && git commit -q -m "fix the race"
`);
    const before = await g(["rev-parse", "develop"], originPath);

    const result = await once({
      ...options(agent),
      issue: 127,
      // No `merge: false`. The recipe is the only thing asking.
      client: fakeClient({ recipe: HUMAN_MERGE_RECIPE, getIssue: async () => issue2(127) }),
    });

    expect(result.ok, JSON.stringify(result)).toBe("held");
    if (result.ok !== "held") return;
    created.add(result.runId);
    expect(result.gate).toBe("merge");

    // Nothing reached the base branch. That is the entire ticket.
    expect((await g(["rev-parse", "develop"], originPath)).stdout).toBe(before.stdout);

    // A real pipeline, not a special case: the same events `prepared` and
    // `proposed` append, stamped with the point they ran at.
    const events = await store.read(result.runId);
    const atMerge = (type: string) =>
      events.filter((e) => e.type === type && (e.data as { gate?: string }).gate === "merge");
    expect(atMerge("GateRequested")).toHaveLength(1);
    expect(atMerge("GateStarted")).toHaveLength(1);

    // And it asks in the vocabulary `--no-merge` already used, naming the
    // action the recipe named rather than inventing a second one.
    const asked = atMerge("ApprovalRequested");
    expect(asked).toHaveLength(1);
    expect(asked[0]!.data).toMatchObject({
      gate: "merge",
      action: "approval",
      onSha: result.headSha,
    });

    // "Waiting on you", not back in the queue where another run could claim it.
    const item = (await store.read(result.workItemId)).map((e) => e.type);
    expect(item).toContain("WorkItemBlocked");
    expect(item).not.toContain("WorkItemReleased");

    // One vocabulary means one way to answer: approving works without knowing
    // which point asked.
    const approved = await approve({
      project: PROJECT,
      issue: 127,
      base: "develop",
      client: fakeClient({ recipe: HUMAN_MERGE_RECIPE, refSha: async () => result.headSha }),
      by: "human:test",
      store,
      home,
      gitEnv: { ...process.env, ...authored },
    });

    expect(approved.ok, JSON.stringify(approved)).toBe(true);
    expect((await g(["rev-parse", "develop"], originPath)).stdout).not.toBe(before.stdout);
  }, 180_000);

  /**
   * The `end` point is a *point*, not a step of `runOnce`.
   *
   * It fired only where that one function merged the branch itself, so
   * everything that landed through an approval merged, appended
   * `WorkItemLanded`, and stopped: the issue stayed open and nothing on GitHub
   * showed that Lingtai had touched it. Two issues landed that way on the day
   * this was found, and the gap was invisible because it had never been
   * exercised — approving is the path an operator who reads diffs always takes.
   */
  it("resolves the end point when an approval is what lands it", async () => {
    created.add(workItemStream(PROJECT, 126));
    const agent = await agentThat(`
mkdir -p src && echo "export const held = 126;" > src/fix.ts
git add -A && git commit -q -m "fix the race"
`);

    const result = await once({
      ...options(agent),
      issue: 126,
      merge: false,
      client: fakeClient({ recipe: CLOSING_RECIPE, getIssue: async () => issue2(126) }),
    });
    expect(result.ok).toBe("held");
    if (result.ok !== "held") return;

    const outcomes = (events: { type: string; data: unknown }[]) =>
      events
        .filter((e) => e.type === "EndActionsResolved")
        .map((e) => (e.data as { outcome: string }).outcome);

    // Held is a terminal outcome too, and the point ran against it: nothing in
    // this recipe matches `blocked`, which is a different fact from the point
    // never having run.
    const whileHeld = await store.read(result.workItemId);
    expect(outcomes(whileHeld)).toEqual(["blocked"]);

    const approved = await approve({
      project: PROJECT,
      issue: 126,
      base: "develop",
      client: fakeClient({ recipe: CLOSING_RECIPE, refSha: async () => result.headSha }),
      by: "human:test",
      store,
      home,
      gitEnv: { ...process.env, ...authored },
    });
    expect(approved.ok, JSON.stringify(approved)).toBe(true);

    const item = await store.read(result.workItemId);
    expect(outcomes(item)).toEqual(["blocked", "landed"]);

    const landed = item.filter(
      (e) => e.type === "EndActionsResolved" && (e.data as { outcome: string }).outcome === "landed",
    );
    // What `tellGitHub` turns into a close. The plan crosses into the log
    // here, so that carrying it out never has to read a recipe — and so that a
    // replay years later does what the recipe said then, not what it says now.
    expect(landed[0]!.data).toEqual({
      outcome: "landed",
      actions: [{ name: "close the ticket", close: true }],
    });

    // In the same append as the landing itself, so the two cannot come apart.
    const at = item.findIndex((e) => e.type === "WorkItemLanded");
    expect(item[at + 1]?.type).toBe("EndActionsResolved");

    // And it resolves *once*. Asking again — a second approval, a replay —
    // appends nothing, and the item's own stream is where that is checked.
    const close: GateAction = { name: "close the ticket", close: true, when: "landed" };
    await appendEndActions(store, result.workItemId, [close], "landed");
    expect(outcomes(await store.read(result.workItemId))).toEqual(["blocked", "landed"]);
  }, 180_000);

  /**
   * The reason the approval carries a sha at all. In the old system approval was
   * a label, and a label survives any amount of rewriting — so a force-push
   * inherited its own approval.
   */
  it("refuses to merge an approval whose branch has moved since", async () => {
    const agent = await agentThat(`
mkdir -p src && echo "export const held = 125;" > src/fix.ts
git add -A && git commit -q -m "fix the race"
`);
    const result = await once({
      ...options(agent),
      issue: 125,
      merge: false,
      client: fakeClient({ getIssue: async () => ({ ...issue, number: 125 }) }),
    });
    expect(result.ok).toBe("held");
    if (result.ok !== "held") return;

    const before = (await g(["rev-parse", "develop"], originPath)).stdout;

    const approved = await approve({
      project: PROJECT,
      issue: 125,
      base: "develop",
      // The branch head is not what was approved: someone pushed after the ask.
      client: fakeClient({ refSha: async () => "9".repeat(40) }),
      by: "human:test",
      store,
      home,
      gitEnv: { ...process.env, ...authored },
    });

    expect(approved.ok).toBe(false);
    if (approved.ok) return;
    expect(approved.reason).toBe("stale");
    // Nothing merged, and the message names both shas rather than saying "no".
    expect(approved.detail).toContain(result.headSha.slice(0, 7));
    expect((await g(["rev-parse", "develop"], originPath)).stdout).toBe(before);
  }, 180_000);

  /**
   * The three things a person can do, and the rules that keep them honest.
   * #21 calls this the ticket the whole project is a bet on.
   */
  describe("deciding", () => {
    const held = async (issue: number, marker: string) => {
      const agent = await agentThat(`
mkdir -p src && echo "export const held = ${marker};" > src/fix.ts
git add -A && git commit -q -m "fix the race"
`);
      const result = await once({
        ...options(agent),
        issue,
        merge: false,
        client: fakeClient({ getIssue: async () => ({ ...issue2(issue) }) }),
      });
      expect(result.ok).toBe("held");
      return result as Extract<typeof result, { ok: "held" }>;
    };

    it("refuses a waiver with no reason, because a silent waiver is the thing being replaced", async () => {
      const r = await held(130, "130");
      const outcome = await waive({
        project: PROJECT,
        issue: 130,
        gate: "merge:no-merge",
        by: "human:test",
        reason: "   ",
        store,
      });

      expect(outcome.ok).toBe(false);
      expect(outcome.detail).toContain("needs a reason");
      expect(r.runId).toBeTruthy();
    }, 180_000);

    it("records who and why on a waiver, and binds it to the commit", async () => {
      const r = await held(131, "131");
      const outcome = await waive({
        project: PROJECT,
        issue: 131,
        gate: "merge:no-merge",
        by: "human:test",
        reason: "unrelated flake in the importer suite",
        store,
      });

      expect(outcome.ok).toBe(true);
      const waived = (await store.read(r.runId)).find((e) => e.type === "GateWaived");
      const d = waived?.data as { by: string; reason: string; onSha: string };
      // Never silent. Both halves, on the event, on the card.
      expect(d.by).toBe("human:test");
      expect(d.reason).toContain("unrelated flake");
      // And about a diff, so a force-push stops it counting by arithmetic.
      expect(d.onSha).toBe(r.headSha);
    }, 180_000);

    it("refuses a decision made against a commit the card is no longer showing", async () => {
      const r = await held(132, "132");
      const outcome = await waive({
        project: PROJECT,
        issue: 132,
        gate: "merge:no-merge",
        by: "human:test",
        reason: "looks fine",
        // What a stale card would send.
        onSha: "0".repeat(40),
        store,
      });

      expect(outcome.ok).toBe(false);
      expect(outcome.detail).toContain(r.headSha.slice(0, 7));
    }, 180_000);

    it("sends a rejection back to the gate rather than to the queue", async () => {
      const r = await held(133, "133");
      const outcome = await reject({
        project: PROJECT,
        issue: 133,
        base: "develop",
        client: fakeClient(),
        by: "human:test",
        reason: "wrong approach",
        store,
      });

      expect(outcome.ok).toBe(true);
      const events = (await store.read(r.runId)).map((e) => e.type);
      expect(events).toContain("ApprovalRevoked");
      // Still waiting on a person, not released for another run to claim and
      // throw the question away.
      const item = (await store.read(r.workItemId)).map((e) => e.type);
      expect(item).not.toContain("WorkItemReleased");
    }, 180_000);

    /**
     * #92 — the board and `lingtai approve` gave two answers to one approval.
     *
     * The card sent `task_view.head_sha`, which is what the run *produced*. A
     * branch repaired and re-offered leaves that where it was and asks about a
     * new head, so `approve()` refused the button and accepted the CLI, which
     * sends no sha and falls through to the run's own `onSha`. `wi-lingtai-73`
     * and `wi-lingtai-77` sat like that.
     *
     * End to end, in the order it happens: request on a new head, read the
     * card, approve from what the card carries, land. The stale guard is
     * exercised on the way past with the value the old card sent, because the
     * fix must not be "stop checking".
     */
    it("approves a repaired head from the card's own inputs, and still refuses a stale one", async () => {
      created.add(workItemStream(PROJECT, 134));
      const r = await held(134, "134");
      created.add(r.runId);
      const before = (await g(["rev-parse", "develop"], originPath)).stdout;

      // The branch is repaired by hand — the path #84 made routine — and
      // approval is re-requested on the head that repair produced.
      const scratch = join(root, "repair-134");
      await exec("git", ["clone", "-q", "-b", "agent/134", originPath, scratch]);
      await writeFile(join(scratch, "src", "repaired.ts"), "export const repaired = 134;\n");
      await g(["add", "-A"], scratch);
      await g(["commit", "-qm", "repair agent/134 by hand"], scratch);
      await g(["push", "-q", "origin", "agent/134"], scratch);
      const repaired = (await g(["rev-parse", "HEAD"], scratch)).stdout.trim();
      expect(repaired).not.toBe(r.headSha);

      const run = await store.read(r.runId);
      await store.append(r.runId, run.length, [
        {
          type: "ApprovalRequested",
          actor: "conductor",
          data: {
            gate: "merge",
            action: "repair",
            runId: r.runId,
            onSha: repaired,
            question: "Merge agent/134 into develop?",
            artifacts: [`agent/134@${repaired}`],
          },
        },
      ]);

      // What the board renders from, read the way the board reads it.
      const runner = createProjectionRunner({ projection: taskViewProjection, store });
      let card: Awaited<ReturnType<typeof readTasks>>[number] | undefined;
      try {
        await runner.start();
        card = (await readTasks({ project: PROJECT })).find((c) => c.issue === "134");
      } finally {
        await runner.close();
      }

      expect(card, "the held item never reached the board").toBeDefined();
      // The two facts, apart: what the run produced, and what it is asking
      // about. The card used to hold only the first and offer it as the second.
      expect(card!.headSha).toBe(r.headSha);
      expect(card!.awaitingSha).toBe(repaired);
      expect(card!.awaitingApproval).toBe(true);

      // The old card's value, which is a diff nobody is being asked about. Still
      // refused, and the refusal names both shas rather than saying "no".
      const stale = await approve({
        project: PROJECT,
        issue: 134,
        base: "develop",
        client: fakeClient({ refSha: async () => repaired }),
        by: "human:test",
        onSha: card!.headSha!,
        store,
        home,
        gitEnv: { ...process.env, ...authored },
      });
      expect(stale.ok).toBe(false);
      if (stale.ok) return;
      expect(stale.reason).toBe("stale");
      expect(stale.detail).toContain(r.headSha.slice(0, 7));
      expect(stale.detail).toContain(repaired.slice(0, 7));
      expect((await g(["rev-parse", "develop"], originPath)).stdout).toBe(before);

      // And the card's own value lands it — the answer `lingtai approve`, which
      // sends no sha at all, has been giving all along.
      const approved = await approve({
        project: PROJECT,
        issue: 134,
        base: "develop",
        client: fakeClient({ refSha: async () => repaired }),
        by: "human:test",
        onSha: card!.awaitingSha!,
        store,
        home,
        gitEnv: { ...process.env, ...authored },
      });

      expect(approved.ok, JSON.stringify(approved)).toBe(true);
      expect((await g(["rev-parse", "develop"], originPath)).stdout).not.toBe(before);
      const log = await exec("git", ["log", "--oneline", "develop"], { cwd: originPath });
      expect(log.stdout).toContain("repair agent/134 by hand");
    }, 240_000);

  });

  /**
   * Taking the queue, which is what "consecutive" in Phase 2's exit criterion
   * means. The dangerous test is the second one.
   */
  describe("the scheduler", () => {
    // Its own project. `runQueue` drains a project's queue, and every other
    // test in this file leaves work items in PROJECT's — so sharing it would
    // make these two assert on their neighbours' rows. The same isolation the
    // live tests already needed.
    const SCHED = `${PROJECT}sched`;
    const schedProject: ProjectState = { ...project, project: SCHED };

    /** `RECIPE`, parsed. `runQueue` asks GitHub itself now, so it needs it. */
    const SCHED_RECIPE = {
      version: 1,
      repo: { base: "develop", submodules: false },
      // `backoff` as the schema resolves it. Hand-built and cast, so nothing
      // fills a default in for it — and `runQueue` reads it every pass (0028).
      source: { kinds: ["bug"], exclude: ["blocked"], backoff: "1h" },
      env: { required: [], plantAt: ".env.local" },
      gates: { admit: [], prepared: [], proposed: [], merge: [], end: [] },
      runtime: { agent: "claude-code", limits: { turns: 10, wall: "2m" } },
    } as unknown as Recipe;

    /**
     * The queue is what GitHub offers, so seeding it means making GitHub say so.
     *
     * It used to mean writing rows into `task_view` through `syncQueued`, which
     * is the cache 0022 deleted — and the fact that a test could seed a queue
     * without GitHub agreeing is close to what #57 was.
     */
    const offering = (refs: number[]): GitHubClient =>
      fakeClient({
        listOpenIssues: async () => refs.map((n) => ({ ...issue2(n), title: `issue ${n}` })),
        getIssue: async (n: number) => ({ ...issue2(n), title: `issue ${n}` }),
      });

    /** `selectRunnable` reads `task_view` to learn what the log already took. */
    const projectionReady = async () => {
      const runner = createProjectionRunner({ projection: taskViewProjection, store });
      try {
        await runner.start();
      } finally {
        await runner.close();
      }
    };

    it("takes items itself, in order, without anyone naming them", async () => {
      await projectionReady();
      const agent = await agentThat(`
mkdir -p src && echo "export const q = $RANDOM;" > src/fix.ts
git add -A && git commit -q -m "fix"
`);

      const outcome = await queue({
        project: schedProject,
        client: offering([140, 141]),
        runtime: createClaudeCodeRuntime({ binary: agent }),
        hookBinary,
        prompt: "fix the race",
        recipe: SCHED_RECIPE,
        max: 2,
        merge: false,
        home,
        store,
        remote: originPath,
        gitEnv: { ...process.env, ...authored },
      });

      // Two, consecutively, and nobody typed a second number.
      expect(outcome.ran).toHaveLength(2);
      expect(outcome.stopped).toBe("max");
      expect(new Set(outcome.attempted).size).toBe(2);
    }, 300_000);

    /**
     * The one that matters. `runOnce` releases a failed item back into the
     * queue, so the obvious loop takes it again immediately — forever, at the
     * price of an agent call per pass. The old loop did a version of this: #58
     * and #59 re-ran five times for roughly $29.
     */
    it("does not take the same failing item twice in one pass", async () => {
      await projectionReady();
      // Fails every time, and is released every time.
      const agent = await agentThat(`echo "no commits from me"; exit 0`);

      const outcome = await queue({
        project: schedProject,
        client: offering([142]),
        runtime: createClaudeCodeRuntime({ binary: agent }),
        hookBinary,
        prompt: "fix the race",
        recipe: SCHED_RECIPE,
        home,
        store,
        remote: originPath,
        gitEnv: { ...process.env, ...authored },
      });

      // One attempt, not an unbounded number of them.
      expect(outcome.ran).toHaveLength(1);
      expect(outcome.ran[0]?.ok).toBe(false);
      // And it says *why* it stopped: the queue is not empty, everything left
      // has been tried. A caller reading this as "all done" would be wrong,
      // which is why it is not called `empty`.
      expect(outcome.stopped).toBe("exhausted");
    }, 300_000);
  });

  /**
   * The defect that made the first real run useless. The prompt said "read the
   * issue" and the agent was handed a number — no title, no body, and no `gh`
   * to fetch one with. Thirty turns and $1.11 later it had written to
   * `.lingtai/config.yaml`, the only thing in the worktree that looked like
   * an instruction, and committed nothing.
   */
  it("gives the implementer the ticket, not just its number", () => {
    const filled = renderPrompt("#{{issue}} — {{title}}\n\n{{body}}", {
      number: 120,
      title: "The dashboard reports state but does not start work",
      body: "`/` shows twelve stat tiles and no way in.",
    });

    expect(filled).toContain("#120");
    expect(filled).toContain("The dashboard reports state");
    expect(filled).toContain("twelve stat tiles");
    // Nothing left for the agent to wonder about.
    expect(filled).not.toContain("{{");
  });

  it("refuses before claiming anything when the recipe cannot be read", async () => {
    const result = await once({
      ...options(await agentThat("true")),
      issue: 119,
      client: fakeClient({ fileAt: async () => null }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // An unreadable recipe stops the run rather than falling back to a default.
    expect(result.stage).toBe("recipe");
    expect(result.workItemId).toBeNull();
    expect(await store.read(workItemStream(PROJECT, 119))).toEqual([]);
  }, 120_000);
});

function workItemId(): string {
  return workItemStream(PROJECT, 117);
}
