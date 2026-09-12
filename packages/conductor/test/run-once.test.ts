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
runtime: { agent: claude-code, limits: { turns: 10, wall: 2m, rounds: 1 } }
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

/**
 * A recipe with a cold reviewer after the build, as Lingtai's own has.
 *
 * The order is the real one and it matters: the first refusal wins, so a diff
 * that does not compile is never paid to be reviewed.
 */
const REVIEWING_RECIPE = RECIPE.replace(
  '- { name: build, run: "test -f src/fix.ts", timeout: 2m }',
  `- { name: build, run: "test -f src/deliver.ts", timeout: 2m }
    - { name: review, agent: "this project cares about swallowed errors" }`,
);

/** A recipe whose only gate refuses, whatever the agent did. */
const REFUSING_RECIPE = RECIPE.replace(
  'run: "test -f src/fix.ts"',
  'run: "echo the build is broken; exit 1"',
);

/**
 * The same, for a project that buys no rounds at all.
 *
 * `runtime.limits.rounds` defaults to 2
 * ([0039](../../../doc/decisions/0039-the-worktree-is-the-whole-of-a-pass.md) §3),
 * so this is the recipe that gets the *other* outcome of a refusal — a block
 * carrying the reason no agent was bought. `rounds: 0` is the whole of what
 * `repair.on: false` used to say.
 */
const NO_ROUNDS_RECIPE = REFUSING_RECIPE.replace(
  "rounds: 1",
  "rounds: 0",
);

/**
 * A gate at the **merge** point that refuses, which is how a `gate-failed`
 * reaches the lane.
 *
 * The one refusal the round loop never sees: `proposed` is where `buyRound`
 * runs, and a `merge`-point verdict is taken by `integrate()` as
 * `gatesPassed: false` and comes back out as `gate-failed`. Before `#143` that
 * bought a whole new run — for exactly the refusal `decideFix` declines to buy
 * a *round* for, a hundred lines away, which is the incoherence the ticket
 * leads with.
 */
const LANE_REFUSING_RECIPE = RECIPE.replace(
  "runtime: {",
  `  merge:
    - { name: policy, run: "echo this branch may not land; exit 1", timeout: 2m }
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
    updateBody: async () => {},
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
   * **A red gate goes back to the agent in the same worktree**
   * ([0039](../../../doc/decisions/0039-the-worktree-is-the-whole-of-a-pass.md) §2),
   * and when the rounds are spent a person is asked.
   *
   * This test used to assert the opposite, and the change is the whole of
   * `#141`. A refusing `run:` action walked on to the merge lane, was refused
   * there a second time as `gate-failed`, and bought an agent for a **whole new
   * run** — re-implementing a branch that was sitting on disk with one command
   * failing on it. The expensive path was never a decision about builds: it was
   * a consequence of the worktree being released before the integrator ran, so
   * there was nowhere to send the refusal back to.
   *
   * `proposed` is inside the worktree's scope already, so this half needed
   * nothing from `#140`. What it needed was for `decideFix` to stop reading "no
   * `findings` field" as "no acceptance criterion": a red build has one, and a
   * harder one than a finding's — *run it again; green is green*.
   *
   * **And the gate here never goes green**, deliberately. The fixer is told
   * what the command printed, commits, the whole point runs again, it refuses
   * again, and the round is spent. That is the path that has to end with a
   * person rather than with another purchase.
   */
  it("sends a red gate back to the agent, and asks a person when the rounds are spent", async () => {
    // A second issue, so the first one's history stays intact.
    const other = { ...issue, number: 118 };
    created.add(workItemStream(PROJECT, 118));

    // Every prompt this run hands out, in order, so the test can read what the
    // fixer was told. Appended rather than written: the implementer and the
    // fixer are the same fake binary, and the second call is the one under test.
    const prompts = join(root, "red-gate-prompts.txt");
    // A commit per call, so a round is a real round: `git commit` on an
    // unchanged tree fails, and a fixer that commits nothing is a *decline*,
    // which is a different test.
    const agent = await agentThat(`
printf '%s\n=====\n' "$2" >> ${prompts}
n=$(git rev-list --count HEAD)
echo "change $n" > CHANGELOG.md
git add -A
git -c user.name=agent -c user.email=a@example.invalid commit -qm "change $n"
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

    // Held, not failed: the point that refused it is where it stopped, and what
    // a person gets is a question on the head the rounds produced.
    expect(result.ok, JSON.stringify(result)).toBe("held");
    if (result.ok !== "held") return;
    created.add(result.runId);

    const run = await store.read(result.runId);
    // One round bought and spent, recorded before the agent ran — the evidence
    // it was handed is the contract, and a log that learned it afterwards could
    // only ever show the rounds that survived.
    const requested = run.filter((e) => e.type === "FixRequested");
    expect(requested).toHaveLength(1);
    expect(requested[0]!.data).toMatchObject({ round: 1, action: "build" });
    expect(run.find((e) => e.type === "FixApplied")!.data).toMatchObject({ round: 1 });

    // **The fixer was told what the command printed, verbatim.** Not a
    // diagnosis of it: a prompt saying "the build failed because X" would hand
    // the agent one reading of the evidence instead of the evidence.
    const handed = (await readFile(prompts, "utf8")).split("\n=====\n");
    expect(handed.length).toBeGreaterThan(2);
    const toTheFixer = handed[1]!;
    expect(toTheFixer).toContain("the build is broken");
    expect(toTheFixer).toMatch(/fix round\s+1 of 1/);
    // And the acceptance test it will be held to, which is the one thing no
    // prose can loosen.
    expect(toTheFixer).toContain("has to go green");
    // Not the reviewer's shape: there are no findings here and the prompt must
    // not pretend there are.
    expect(toTheFixer).not.toContain("failure scenario");

    // Then a person, and **no repair**: one ceiling has to mean one
    // destination, or a build that spent every round would also buy a run.
    expect(run.some((e) => e.type === "RepairRequested")).toBe(false);
    const asked = run.find((e) => e.type === "ApprovalRequested");
    expect(asked!.data).toMatchObject({ gate: "proposed", action: "unfixed" });
    expect((asked!.data as { question: string }).question).toContain("still red after 1 fix round");

    const events = await store.read(workItemStream(PROJECT, 118));
    expect(events.map((e) => e.type)).toEqual([
      "WorkItemClaimed",
      "IssueUpdated",
      "WorkItemBlocked",
      "IssueUpdated",
      "IssueUpdated",
    ]);
    const item = reduceWorkItem(events).lifecycle;
    expect(item.status).toBe("blocked");
    // The card says what stayed red and that it stayed red, rather than naming
    // a stage: this is a check that failed and kept failing, not a judgement.
    expect(item.status === "blocked" && item.diagnosis?.what).toContain("still refuses");
    expect(item.status === "blocked" && item.diagnosis?.raw).toContain("the build is broken");

    // The one thing it must not be is merged.
    const log = await exec("git", ["log", "--oneline", "develop"], { cwd: originPath });
    expect(log.stdout).not.toContain("change ");
  }, 240_000);

  /**
   * The other outcome, and the one that must never be an absence.
   *
   * A project that buys no rounds still has to end up somewhere a person can
   * act. So the block carries the reason no agent was bought — `#84`'s *"the
   * card says so and offers whatever the remaining move is, rather than a
   * control that refuses"*.
   *
   * `rounds: 0` is the whole of what `repair.on: false` used to say (0039 §4):
   * a boolean beside a count whose zero already means the same thing was a
   * redundant pair, and the count is in the block an operator reads for limits.
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
        recipe: NO_ROUNDS_RECIPE,
        getIssue: async () => other,
        listOpenIssues: async () => [other],
      }),
    });

    // **Held, not failed** (0039 §3). Before 0039 a refusing gate walked on to
    // the merge lane, was refused a second time as `gate-failed`, and came back
    // as a typed failure at `integrate`. It stops at the point that refused it
    // now, and what a person gets is a question rather than a stage name.
    expect(result.ok, JSON.stringify(result)).toBe("held");
    if (result.ok !== "held") return;
    created.add(result.runId);

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
      "WorkItemBlocked",
      "IssueUpdated",
      "IssueUpdated",
    ]);

    // The decline is recorded on the *run*, where the rounds are spent, and it
    // says which rule refused: "nothing happened because nobody asked for it"
    // and "nothing happened and we do not know why" are the two things a log
    // exists to keep apart.
    const run = await store.read(result.runId);
    expect(run.find((e) => e.type === "FixDeclined")!.data).toMatchObject({
      action: "build",
      why: expect.stringContaining("runtime.limits.rounds: 0"),
    });
    // And no agent ran: `rounds: 0` is a refusal to buy, not a round that
    // failed.
    expect(run.some((e) => e.type === "FixRequested")).toBe(false);

    // And the sentence reaches the card, which is the whole point of recording
    // it: a question with no reason in it is the thing being replaced.
    const item = reduceWorkItem(events).lifecycle;
    expect(item.status).toBe("blocked");
    expect(item.status === "blocked" && item.question).toContain("build");

    const log = await exec("git", ["log", "--oneline", "develop"], { cwd: originPath });
    expect(log.stdout).not.toContain("unrepaired change");
  }, 240_000);

  /**
   * **A lane refusal buys nothing and reaches a person with a reason** — the
   * path `#143` turns into the only one, and the one it had to be pinned by.
   *
   * `decideRepair` used to stand here and buy a whole new run for a
   * `gate-failed` or a `no-commits`. Both are answered by
   * [0039](../../../doc/decisions/0039-the-worktree-is-the-whole-of-a-pass.md)
   * §Consequences and neither deserved one: a `gate-failed` at the lane is the
   * refusal `decideFix` declines to buy a *round* for, and a `no-commits` is a
   * branch holding nothing, which a run starting from scratch answers by
   * definition and expensively.
   *
   * So what is asserted is the whole outcome, because there is nothing else:
   * blocked, a question carrying the refusal, and `diagnoseRefusal`'s three
   * sentences — what refused, whose failure it is and why no agent is coming,
   * and the raw output underneath. Plus the absence that is the change:
   * nothing released the item and nothing appended either retired event.
   */
  it("blocks for a person when the lane refuses, and buys nothing", async () => {
    const other = { ...issue, number: 143 };
    created.add(workItemStream(PROJECT, 143));

    const agent = await agentThat(`
mkdir -p src && echo "export const fix = 143;" > src/fix.ts
git add -A
git -c user.name=agent -c user.email=a@example.invalid commit -qm 'a change the lane will not take'
`);

    const result = await once({
      ...options(agent),
      issue: 143,
      client: fakeClient({
        recipe: LANE_REFUSING_RECIPE,
        getIssue: async () => other,
        listOpenIssues: async () => [other],
      }),
    });

    // A typed refusal at `integrate`, and not a hold: the `merge` point ran a
    // command rather than asking anybody, so the lane is what said no.
    expect(result.ok, JSON.stringify(result)).toBe(false);
    if (result.ok !== false) return;
    expect(result.stage).toBe("integrate");
    expect(result.detail).toContain("gate-failed");
    if (result.runId) created.add(result.runId);

    const events = await store.read(workItemStream(PROJECT, 143));
    const types = events.map((e) => e.type);
    // **Nothing was bought and nothing was declined**, because there is no
    // longer a decision to record either way. Both types are retired and
    // `store.append` refuses them, so this is the shape of the code rather
    // than a promise about it.
    expect(types).not.toContain("RepairRequested");
    expect(types).not.toContain("RepairDeclined");
    // And it did not go back to the queue, which is the other wrong answer: a
    // fresh pass would cut a branch from the base and meet the same gate.
    expect(types).not.toContain("WorkItemReleased");
    expect(types).toContain("WorkItemBlocked");

    const item = reduceWorkItem(events).lifecycle;
    expect(item.status).toBe("blocked");
    if (item.status !== "blocked") return;
    // A failure to acknowledge, not a judgement being asked for.
    expect(item.needs).toBe("acknowledgement");
    expect(item.question).toContain("gate-failed");
    // The sentence, rather than the reason code the question still carries.
    expect(item.diagnosis?.what).toBe(
      `a gate refused agent/143, so it was not merged into develop.`,
    );
    // Whose failure it is and why nothing is coming — `whoseFailure`'s answer,
    // composed by `diagnoseRefusal` and handed in by nobody.
    expect(item.diagnosis?.done).toContain("No agent was bought");
    expect(item.diagnosis?.done).toContain("inside the pass it happened in");
    // The gate's own output underneath, never summarised away (#83).
    expect(item.diagnosis?.raw).toContain("this branch may not land");
    // And no move: approving a red diff over a refusing gate, waiving it, or
    // rejecting it is the one judgement nothing but a person should make.
    expect(item.diagnosis?.recommendation).toBeNull();

    const log = await exec("git", ["log", "--oneline", "develop"], { cwd: originPath });
    expect(log.stdout).not.toContain("the lane will not take");
  }, 240_000);

  it("lets a person hand a still-red item back to the queue", async () => {
    const back = await requeue({
      project: PROJECT,
      issue: 134,
      by: "human:test",
      note: "the build needs a person; a fresh branch should start from it",
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

  /**
   * The two moves left on it, and `#84`'s requirement that there always be one.
   *
   * An item whose gate stayed red is never left in a state with no path
   * forward. Before 0039 there was exactly one move — hand it back to the queue
   * — because the run was `gating` and its approval, if it had one, was spent;
   * `approve()` refused with `not-awaiting-approval` and the board's control
   * did nothing.
   *
   * **There are two now, and the first one is new.** The pass stopped at
   * `proposed` and asked, so there is a live `ApprovalRequested` bound to the
   * head the rounds produced — a person who has read the failure can merge it
   * anyway. That is the same escape a disagreement has had since 0038, reaching
   * a red build because 0039 stopped treating the two as different flows.
   */
  /**
   * **A conflict is answered in the worktree, not by a new run** (0039 §2,
   * `#142`), and this is the refusal that used to cost the most.
   *
   * The lane merged the base in, found it does not apply, aborted, and the item
   * went back to the queue so a *whole new run* could re-implement a branch that
   * was sitting on disk, finished and green, needing a merge resolved. git had
   * already named the conflicting files. What was missing was somewhere to send
   * it back to — the worktree was released before the integrator ran, and `#140`
   * is what changed that.
   *
   * **The base is moved by the agent's own first invocation**, which is the only
   * way to make the race deterministic: the worktree is already cut, so a commit
   * pushed to `develop` from anywhere at that moment is exactly the situation
   * the lane meets a second later.
   *
   * The fixer knows which invocation it is by asking git, not by being told —
   * `MERGE_HEAD` exists only in the middle of a merge, which is where the
   * conductor leaves it. That is the design under test as much as the routing
   * is: **a description of a conflict is not something anyone can resolve, and
   * the markers are.**
   */
  it("sends a conflict back to the worktree, and the lane is re-entered after it", async () => {
    const other = { ...issue, number: 152 };
    created.add(workItemStream(PROJECT, 152));

    const prompts = join(root, "conflict-prompts.txt");
    const mover = join(root, "mover");
    const agent = await agentThat(`
printf '%s\n=====\n' "$2" >> ${prompts}
if git rev-parse -q --verify MERGE_HEAD > /dev/null 2>&1; then
  printf 'theirs\nours\n' > CONFLICT.md
  git add -A
  git -c user.name=agent -c user.email=a@example.invalid commit -qm 'resolved the conflict'
else
  mkdir -p src && echo "export const fix = 152;" > src/fix.ts
  printf 'ours\n' > CONFLICT.md
  git add -A
  git -c user.name=agent -c user.email=a@example.invalid commit -qm 'the change'
  rm -rf ${mover}
  git clone -q ${originPath} ${mover}
  cd ${mover}
  git checkout -q develop
  printf 'theirs\n' > CONFLICT.md
  git add -A
  git -c user.name=other -c user.email=o@example.invalid commit -qm 'somebody else landed this'
  git push -q origin develop
fi
`);

    // The lane's stream is per base and every test in this file merges into the
    // same one, so what this run did is what came after here.
    const laneBefore = (await store.read(integrationStream(PROJECT, "develop"))).length;

    const result = await once({
      ...options(agent),
      issue: 152,
      client: fakeClient({ getIssue: async () => other, listOpenIssues: async () => [other] }),
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok !== true) return;
    created.add(result.runId);

    const run = await store.read(result.runId);

    // One round, bought by the lane rather than by a gate — the same ceiling,
    // spent on the refusal that happened.
    const requested = run.filter((e) => e.type === "FixRequested");
    expect(requested).toHaveLength(1);
    expect(requested[0]!.data).toMatchObject({ round: 1, action: "merge" });

    // **No repair.** The whole point is that this costs a round inside the pass
    // rather than a run outside it.
    expect(run.some((e) => e.type === "RepairRequested")).toBe(false);
    const items = (await store.read(workItemStream(PROJECT, 152))).map((e) => e.type);
    expect(items).not.toContain("RepairRequested");

    // The lane refused once and was re-entered. Its own stream, per base, is
    // where it records that — `#58`'s rule that no path leaves the integrator
    // without an event is what makes this readable at all.
    const lane = (await store.read(integrationStream(PROJECT, "develop"))).slice(laneBefore);
    const refusedConflict = lane.filter(
      (e) => e.type === "IntegrationRefused" && (e.data as { reason?: string }).reason === "conflict",
    );
    expect(refusedConflict.length, "the lane never hit the conflict this test sets up").toBe(1);
    // And then it landed, which is the re-entry: one refusal, one success, one
    // pass.
    expect(lane.filter((e) => e.type === "IntegrationSucceeded")).toHaveLength(1);

    // What the resolving agent was handed: the conflict in its tree, and the
    // file git named. Not a description of one.
    const handed = (await readFile(prompts, "utf8")).split("\n=====\n");
    const toTheFixer = handed[1]!;
    expect(toTheFixer).toMatch(/in the middle of that merge right now/i);
    expect(toTheFixer).toContain("CONFLICT.md");
    expect(toTheFixer).toContain("`develop` moved");
    // And the acceptance test that stops it taking a side.
    expect(toTheFixer).toMatch(/both have to\s+pass/i);

    // It landed, with both sides of the conflict in the base.
    const merged = await exec("git", ["show", "develop:CONFLICT.md"], { cwd: originPath });
    expect(merged.stdout).toContain("theirs");
    expect(merged.stdout).toContain("ours");
  }, 300_000);

  /**
   * A refused review buys an agent, the review runs again, and **the cheap way
   * to pass is caught**
   * ([0038](../../../doc/decisions/0038-a-finding-buys-an-agent-before-it-buys-your-attention.md)).
   *
   * This is the Goodhart test the ticket asks for, attempted exactly: the fixer
   * is given a `blocker` whose scenario is a swallowed error, and it answers by
   * **deleting the capability** rather than by fixing it. A re-review asked *do
   * you still have this complaint* would have nothing to say. A re-review asked
   * *does that sequence still produce that outcome* — against a scenario written
   * before anybody knew what the fix would be — reports it again, and the item
   * reaches a person as two agents disagreeing rather than as a gate refusing.
   *
   * Four agent calls in one run, told apart by their prompts, because that is
   * what the loop actually is: implement, review, fix, review again.
   */
  it("buys a fixing agent for a refused review, asks again, and catches a fix that only deletes", async () => {
    const other = { ...issue, number: 136 };
    created.add(workItemStream(PROJECT, 136));

    // The failure scenario, written once here and asserted everywhere it has to
    // survive: the fixer's prompt, the re-review's prompt, and the log.
    const scenario =
      "call deliver() with a path whose read fails: readFile throws, the catch returns " +
      "ok true with an empty body, and the caller records a delivery that never happened";
    const findings = {
      findings: [
        {
          file: "src/deliver.ts",
          line: 4,
          severity: "blocker",
          claim: "a failed read is swallowed and the delivery resolves as a success",
          failureScenario: scenario,
        },
      ],
    };
    const receipt = (over: Record<string, unknown> = {}) =>
      JSON.stringify({
        is_error: false,
        num_turns: 4,
        duration_ms: 1234,
        total_cost_usd: 0.11,
        ...over,
      });

    const reviewPrompt = join(root, "136-review.txt");
    const fixPrompt = join(root, "136-fix.txt");
    const recheckPrompt = join(root, "136-recheck.txt");

    // One script, four roles. The order of the first two cases matters: a
    // re-review is a review, and it is the more specific pattern.
    const agent = join(root, "agent-136.sh");
    await writeFile(
      agent,
      `#!/bin/sh
set -e
case "$2" in
  *"Scenarios that must no longer happen"*)
    printf '%s' "$2" > ${recheckPrompt}
    printf '%s\\n' '${receipt({ result: JSON.stringify(findings) })}'
    exit 0
    ;;
  *"You are reviewing a change you did not write"*)
    printf '%s' "$2" > ${reviewPrompt}
    printf '%s\\n' '${receipt({ result: JSON.stringify(findings) })}'
    exit 0
    ;;
  *"you are the fix"*)
    printf '%s' "$2" > ${fixPrompt}
    # The silencing fix, attempted on purpose: the code the finding names is
    # gone, and with it the capability. Nothing about the scenario is addressed.
    echo 'export const deliver = null;' > src/deliver.ts
    git add -A
    git -c user.name=fixer -c user.email=f@example.invalid commit -qm 'remove the reader'
    printf '%s\\n' '${receipt()}'
    exit 0
    ;;
esac
mkdir -p src
cat > src/deliver.ts <<'TS'
export async function deliver(path) {
  try {
    return { ok: true, body: await readFile(path) };
  } catch {
    return { ok: true, body: "" };
  }
}
TS
git add -A
git -c user.name=agent -c user.email=a@example.invalid commit -qm 'deliver the log'
printf '%s\\n' '${receipt()}'
`,
    );
    await chmod(agent, 0o755);

    const result = await once({
      ...options(agent),
      issue: 136,
      client: fakeClient({
        recipe: REVIEWING_RECIPE,
        getIssue: async () => other,
        listOpenIssues: async () => [other],
      }),
    });

    // Held, not merged and not failed: a judgement is waiting on a person.
    expect(result.ok, JSON.stringify(result)).toBe("held");
    if (result.ok !== "held") return;
    created.add(result.runId);

    const run = await store.read(result.runId);
    const types = run.map((e) => e.type);

    // ---- the loop ran, in this order ----
    expect(types).toContain("FixRequested");
    expect(types).toContain("FixApplied");
    // Two refusals from the same action: the review, and the review again.
    const refusals = run.filter(
      (e) => e.type === "GateFailed" && (e.data as { action: string }).action === "review",
    );
    expect(refusals).toHaveLength(2);

    // ---- the acceptance contract, on the log and in both prompts ----
    const bought = run.find((e) => e.type === "FixRequested")!;
    expect(bought.data).toMatchObject({ round: 1, action: "review" });
    // Verbatim on the log, because the scenario is the criterion and a summary
    // of it is a different, looser one.
    expect((bought.data as { findings: { failureScenario: string }[] }).findings[0]!.failureScenario).toBe(
      scenario,
    );

    const handed = await readFile(fixPrompt, "utf8");
    expect(handed).toContain(scenario);
    expect(handed).toMatch(/change nothing else/i);
    // The findings **and the diff** (0038 §3), which is the same diff the
    // reviewer was shown rather than one the fixer had to guess the base of.
    expect(handed).toContain("## The change under review");
    expect(handed).toContain("+++ b/src/deliver.ts");
    // 0038 §3, asserted rather than intended: the fixer gets the findings and
    // the diff, and nothing the implementer was told or said. The implementer's
    // prompt is "fix the race" filled from the ticket; none of it is here.
    expect(handed).not.toContain("fix the race");
    expect(handed).not.toContain("a race in the importer");

    const again = await readFile(recheckPrompt, "utf8");
    expect(again).toContain(scenario);
    expect(again).toMatch(/does that sequence still produce that outcome/i);
    // And it is the diff after the fix that was re-read.
    expect(again).toContain("export const deliver = null");

    // ---- what a person is shown ----
    const events = await store.read(workItemStream(PROJECT, 136));
    const item = reduceWorkItem(events);
    expect(item.lifecycle.status).toBe("blocked");
    if (item.lifecycle.status !== "blocked") return;
    expect(item.lifecycle.needs).toBe("judgement");
    expect(item.lifecycle.question).toContain("two agents disagreed");
    // The criterion in as many words: not *a gate refused*.
    expect(item.lifecycle.diagnosis?.what).toContain("Two agents disagreed");
    expect(item.lifecycle.diagnosis?.what).not.toMatch(/gate refused/i);
    expect(item.lifecycle.diagnosis?.done).toContain("1 round(s) of fix-and-re-review ran");
    // The findings verbatim underneath, scenario included.
    expect(item.lifecycle.diagnosis?.raw).toContain(scenario);

    // ---- and nothing bought a whole new run ----
    // The merge lane was never reached, so there was never a `RepairRequested`
    // here — and since `#143` there is nowhere one could come from: the type is
    // retired and `store.append` refuses it.
    expect(types).not.toContain("RepairRequested");
    expect(events.map((e) => e.type)).not.toContain("RepairRequested");
    const lane = await store.read(integrationStream(PROJECT, "develop"));
    expect(
      lane.filter((e) => (e.data as { workItemId?: string }).workItemId === workItemStream(PROJECT, 136)),
    ).toEqual([]);

    // Nothing merged, and the branch is on the remote for a person to read.
    const log = await exec("git", ["log", "--oneline", "develop"], { cwd: originPath });
    expect(log.stdout).not.toContain("deliver the log");
  }, 240_000);

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
