/**
 * The onboarding wizard's last screen, and the one write the whole of
 * onboarding makes (#165,
 * [the design](../../../doc/design/the-onboarding-wizard.md), *The last screen
 * is the queue, not a warning*).
 *
 * **Onboarding takes work immediately** — there is no *start paused* — so a
 * repository with thirty open issues is thirty tickets an agent may take on the
 * next pass, and with `merge: []` merged with nobody reading them. A warning
 * would not be enough here, and it does not have to be: `selectRunnable` is
 * *what GitHub offers* minus *what `task_view` says*, and a repository that has
 * never run **has no `task_view` rows** — so the first pass is exactly
 * derivable from the kinds and exclude just chosen. `firstPass` below is
 * `lingtai status` for a project that does not exist yet.
 *
 * **It calls `selectRunnable` and `passedOver` rather than reimplementing
 * them.** The number on this screen and the number `lingtai status` prints an
 * hour later are a promise to the operator, and the only thing that keeps a
 * promise like that is a shared function — the argument `backingOff` and
 * `passCeiling` are already here for (#100).
 *
 * Then `startOnboarding`: validate, open the pull request, append
 * `ProjectOnboardingStarted`. **Up to that call the wizard has written nothing
 * anywhere** — no labels, no branch, no event — which is `lingtai add`'s own
 * rule that *a half-onboarded project is not a state that exists*, inherited by
 * the page. Abandon before it and there is nothing to clean up.
 */
import {
  isPending,
  isRegistered,
  parsePayload,
  projectStream,
  reduceProject,
} from "@lingtai/domain";
import { type EventStore, eventStore } from "@lingtai/event-store";
import { GitHubError, type GitHubClient } from "@lingtai/github";
import {
  RECIPE_PATH,
  Recipe,
  type Said,
  emitRecipe,
  parseDuration,
  resolveRecipe,
} from "@lingtai/recipe";
import { passedOver, runnableNow } from "./discover.ts";
import { type Runnable, selectRunnable } from "./queue.ts";

export interface FirstPassOptions {
  client: GitHubClient;
  /** The recipe the wizard just built — not one read from a branch; there is none yet. */
  recipe: Recipe;
  /** Injectable so a test does not have to wait an hour. */
  now?: Date;
}

/** What pressing the button starts, and what it will leave alone. */
export interface FirstPass {
  /** `selectRunnable`'s answer, in the order the conductor will claim them. */
  taking: Runnable[];
  /** `discover.ts`'s own sentence, word for word, or null when nothing was passed over. */
  passedOver: string | null;
  /** `discover.ts`'s own sentence about a GitHub that reports no dependencies. */
  dependenciesUnread: string | null;
  /** `12 runnable · 18 passed over — excluded-label 14, no-kind 4`. */
  line: string;
}

/**
 * The next pass, computed before the project exists.
 *
 * Three calls and no rule of its own: GitHub is asked what it offers
 * (`runnableNow`), the log is subtracted (`selectRunnable`), and the remainder
 * is counted in the words `lingtai status` counts it in (`passedOver`). The
 * subtraction is a no-op today — a repository with no `task_view` rows has
 * nothing to subtract — and it is made anyway, because the claim this screen
 * makes is *this is what the queue will do*, and the queue is that function.
 *
 * `project` is the repository's own name, which is what `task_view` and
 * `prj-…` are keyed by, so it is taken off the client rather than passed in
 * beside it.
 */
export async function firstPass(options: FirstPassOptions): Promise<FirstPass> {
  const { client, recipe } = options;
  const offered = await runnableNow({ client, recipe });
  const taking = await selectRunnable({
    project: client.repo,
    offered: offered.runnable,
    kinds: recipe.source.kinds,
    // The recipe's, not a constant here (0028). Nothing has been attempted, so
    // it holds nothing — a window read off the wrong recipe would still be the
    // wrong window the first time this screen is shown for a re-onboarding.
    backoffMs: parseDuration(recipe.source.backoff),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const passed = passedOver(offered.skipped);
  return {
    taking,
    passedOver: passed,
    dependenciesUnread: offered.dependenciesUnread,
    line: `${taking.length} runnable` + (passed === null ? "" : ` · ${passed}`),
  };
}

/**
 * What lands in this repository without anybody reading it, in one sentence —
 * null when somebody does.
 *
 * **The one place the wizard argues.** With no `gates.proposed` and `merge: []`
 * the whole chain is *an agent writes code, nothing checks it, it lands in the
 * base branch, nobody read it*, and many repositories have no tests. The
 * sentence is said on the last screen and repeated in the pull request body,
 * because those are the two places somebody is deciding.
 */
export function nothingReadsIt(recipe: Recipe): string | null {
  if (recipe.gates.merge.length > 0) return null;
  if (recipe.gates.proposed.length > 0) return null;
  return `Nothing checks a diff before it merges. Every ticket goes from an agent straight into \`${recipe.repo.base}\`.`;
}

/**
 * The hold this repository's own recipe will honour, or null when none will.
 *
 * `Hold all` writes a label, and a label the recipe does not exclude holds
 * nothing — the button would report thirty successes and the next pass would
 * take all thirty. So the label comes out of `source.exclude` rather than being
 * a constant: `agent:hold` when the proposal's recommended set is intact, and
 * otherwise whatever this operator kept. It need not exist on GitHub yet, which
 * is why nothing creates it: a label is created the first time it is applied.
 */
export const HOLD_LABEL = "agent:hold";

export function holdLabel(recipe: Recipe): string | null {
  const exclude = recipe.source.exclude;
  if (exclude.length === 0) return null;
  return exclude.includes(HOLD_LABEL) ? HOLD_LABEL : exclude[0]!;
}

export interface HoldAllOptions {
  client: GitHubClient;
  /** Exactly the issues the screen listed — `FirstPass.taking`'s `issue`s. */
  issues: readonly string[];
  /** `holdLabel`'s answer. */
  label: string;
}

export interface HoldAllResult {
  /** Issues now carrying the label, including any that already did. */
  held: number[];
  /** Issues GitHub refused, and what it said. */
  failed: { issue: number; detail: string }[];
}

/**
 * Applies the hold to exactly the listed issues.
 *
 * **Offered and never taken automatically.** Thirty of these is thirty API
 * writes and thirty timeline entries in somebody's repository; that is the
 * operator's to spend, not ours, so nothing in `startOnboarding` calls it.
 *
 * The label is *added* to the set each issue already carries, read back
 * immediately before the write. `setLabels` replaces, which is right for a
 * state Lingtai computes and wrong for this: a hold a person is applying must
 * not take an issue's other labels off with it.
 *
 * One at a time, and a refusal on one does not stop the rest. Thirty parallel
 * writes is how an installation meets a secondary rate limit, and a screen that
 * reports *nine held, one refused* is more use than one that reports a single
 * error over an unknown prefix of the list.
 */
export async function holdAll(options: HoldAllOptions): Promise<HoldAllResult> {
  const result: HoldAllResult = { held: [], failed: [] };
  for (const ref of options.issues) {
    const n = Number(ref);
    try {
      const issue = await options.client.getIssue(n);
      const carried = issue.labels.map((l) => l.name);
      if (!carried.includes(options.label)) {
        await options.client.setLabels(n, [...carried, options.label]);
      }
      result.held.push(n);
    } catch (err) {
      result.failed.push({ issue: n, detail: (err as Error).message });
    }
  }
  return result;
}

/** The recipe as a file, or the reason there will be no pull request. */
export type Validated = { ok: true; file: string } | { ok: false; refusal: string };

/**
 * The generated recipe, parsed by the system's own parser before anything opens.
 *
 * A pull request that merges and then fails `lingtai add` leaves a bad file on
 * the base branch, where the next thing to read it is a run. So it is parsed
 * here, twice over and deliberately:
 *
 * - `Recipe.safeParse` on the value, which is what names the field. `source.kinds`
 *   has `.min(1)`, and *kinds: array must contain at least 1 element* is a
 *   sentence an operator can act on where a stack trace is not.
 * - `resolveRecipe` on the **bytes**, through the same reader `lingtai add`
 *   will use an hour from now. What lands is a file, not a value, and between
 *   the two sits `emitRecipe` — a comment in the wrong place or a preset that
 *   will not apply is caught here rather than on the base branch.
 */
export async function validateProposal(recipe: Recipe, said: Said = {}): Promise<Validated> {
  const parsed = Recipe.safeParse(recipe);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    return { ok: false, refusal: `the recipe is not valid:\n  ${problems.join("\n  ")}` };
  }

  let file: string;
  try {
    file = emitRecipe(parsed.data, said);
  } catch (err) {
    return { ok: false, refusal: `the recipe could not be written down: ${(err as Error).message}` };
  }

  try {
    // A reader that answers from the string in hand. `resolveRecipe` is async
    // because the real one fetches; nothing is fetched here, and the ref is
    // only what a refusal will name — the branch it would land on.
    await resolveRecipe(async () => file, parsed.data.repo.base);
  } catch (err) {
    return { ok: false, refusal: (err as Error).message };
  }
  return { ok: true, file };
}

export interface StartOnboardingOptions {
  client: GitHubClient;
  /** The recipe the wizard built. Its `repo.base` is the branch the PR targets. */
  recipe: Recipe;
  /** The sentences the page showed, by dotted path — the file's comments and the PR body. */
  said?: Said;
  /** Who pressed it — `human:<id>`. */
  by: string;
  /** The branch the recipe lands on. */
  branch?: string;
  store?: EventStore;
}

export type Started =
  | { ok: true; pr: { number: number; url: string }; branch: string }
  | { ok: false; refusal: string };

/** Where the recipe lands. One name, so a second press is refused rather than duplicated. */
export const ONBOARDING_BRANCH = "lingtai/onboarding";

/**
 * The button: validate, open the pull request, record that onboarding started.
 *
 * **The first and only write in the whole wizard**, and the order inside it is
 * the same rule at a smaller scale — everything that can refuse, refuses before
 * anything is written:
 *
 * 1. the stream, because a repository already recorded must not collect a
 *    second `ProjectOnboardingStarted` and a second pull request;
 * 2. the recipe, by `validateProposal` above;
 * 3. the branch, because `git/refs` on a name that exists is a 422 *after* it
 *    has been asked for and tells an operator nothing they can act on.
 *
 * Then the branch, the file and the pull request, and then the event. The event
 * last because it is the thing the board reads: a card offering `Recheck` for a
 * pull request that was never opened is a state nobody can get out of.
 *
 * **The pull request targets `repo.base`, and there is no second base here.**
 * The recipe has to land on the branch it governs — that is 0005 — and the base
 * recorded on the event is a copy of that one value rather than a decision
 * taken beside it (#75). `Recheck` replays it as the hint it is (#163).
 */
export async function startOnboarding(options: StartOnboardingOptions): Promise<Started> {
  const { client, recipe } = options;
  const store = options.store ?? eventStore;
  const slug = `${client.owner}/${client.repo}`;
  const base = recipe.repo.base;
  const branch = options.branch ?? ONBOARDING_BRANCH;
  const stream = projectStream(client.repo);

  const existing = await store.read(stream);
  const state = reduceProject(existing);
  if (isRegistered(state)) {
    return { ok: false, refusal: `${slug} is already registered — its recipe is on ${state.base}` };
  }
  if (isPending(state)) {
    return {
      ok: false,
      refusal:
        `${slug} is already on its way in — onboarding was recorded for it and ${RECIPE_PATH} ` +
        `has not landed on ${state.base} yet. Merge the pull request that opened it, then press Recheck.`,
    };
  }

  const validated = await validateProposal(recipe, options.said ?? {});
  if (!validated.ok) return { ok: false, refusal: validated.refusal };

  if (await branchExists(client, branch)) {
    return {
      ok: false,
      refusal: `${slug} already has a branch called ${branch} — delete it, or the pull request on it is the one to merge.`,
    };
  }

  let pr: { number: number; url: string };
  try {
    const sha = await client.refSha(base);
    await client.request("POST", `/repos/${client.owner}/${client.repo}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha,
    });
    await client.request("PUT", `/repos/${client.owner}/${client.repo}/contents/${RECIPE_PATH}`, {
      message: `feat(lingtai): ${client.repo} is managed by Lingtai`,
      content: Buffer.from(validated.file, "utf8").toString("base64"),
      branch,
    });
    const opened = await client.request<{ number: number; html_url: string }>(
      "POST",
      `/repos/${client.owner}/${client.repo}/pulls`,
      {
        title: `Lingtai: ${RECIPE_PATH}`,
        head: branch,
        base,
        body: pullRequestBody(recipe, options.said ?? {}),
      },
    );
    pr = { number: opened.number, url: opened.html_url };
  } catch (err) {
    return { ok: false, refusal: `the pull request was not opened: ${(err as Error).message}` };
  }

  await store.append(stream, existing.length, [
    {
      type: "ProjectOnboardingStarted",
      actor: options.by,
      data: parsePayload("ProjectOnboardingStarted", { slug, base, by: options.by }),
    },
  ]);

  return { ok: true, pr, branch };
}

/** Whether a branch is already there. A 404 is the answer, not a failure. */
async function branchExists(client: GitHubClient, branch: string): Promise<boolean> {
  try {
    await client.request("GET", `/repos/${client.owner}/${client.repo}/git/ref/heads/${branch}`);
    return true;
  } catch (err) {
    if (err instanceof GitHubError && err.status === 404) return false;
    throw err;
  }
}

/**
 * What the pull request says, in the sentences the wizard showed.
 *
 * `said` is the same record `emitRecipe` writes into the file as comments, so
 * the diff and the description cannot come to explain the recipe differently —
 * and neither of them is copy invented here. What this adds around them is the
 * two facts a reader of the *pull request* needs and the file does not say:
 * what happens when it merges, and what nothing will read before a diff lands.
 */
export function pullRequestBody(recipe: Recipe, said: Said = {}): string {
  const lines = [
    `Lingtai will read \`${RECIPE_PATH}\` from \`${recipe.repo.base}\` once this merges,`,
    "and work the issues labelled " +
      `${recipe.source.kinds.map((k) => `\`${k}\``).join(", ")} — in that order of priority.`,
    "",
  ];

  const sentences = Object.entries(said);
  if (sentences.length > 0) {
    lines.push("What it sets:", "");
    for (const [path, sentence] of sentences) {
      lines.push(`- \`${path}\` — ${sentence.replace(/\s+/g, " ").trim()}`);
    }
    lines.push("");
  }

  const warning = nothingReadsIt(recipe);
  if (warning !== null) lines.push(`**${warning}**`, "");

  lines.push("Merge this, then press Recheck on the board to finish onboarding.");
  return lines.join("\n");
}
