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
 * `ProjectOnboardingStarted`. **It is the only write the wizard makes of its
 * own accord** — no branch and no event exist before it — which is `lingtai
 * add`'s own rule that *a half-onboarded project is not a state that exists*,
 * inherited by the page.
 *
 * **`Hold all` is the exception, and it is the operator's own write.** It sits
 * on this same last screen, it runs before the button, and it puts a label on
 * every issue it is given — in somebody's repository, visible to everyone, with
 * nothing on Lingtai's log recording that Lingtai did it, because the project
 * has no stream yet. So *abandon and there is nothing to clean up* holds for
 * everything the wizard does by itself and not for a button a person pressed:
 * the labels stay, and taking them off is theirs. The screen has to say so.
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
 * Two things have to be true of the label `Hold all` writes, and only one of
 * them is in the recipe. It must be **excluded**, or the button reports thirty
 * successes and the next pass takes all thirty. And it must **mean a hold**,
 * which is a thing the recipe cannot say: `source.exclude` is free-form, so
 * `wontfix` and `epic` are as excluded as `agent:hold` is, and stamping
 * `wontfix` across twelve open bug reports is a sentence about them that Lingtai
 * is not entitled to write — visible to every human and every other tool reading
 * that repository, with nothing on the log saying Lingtai did it.
 *
 * So only `agent:hold` qualifies. It is the one name Lingtai defines as meaning
 * *not yet*, and a recipe that does not exclude it gets no button rather than a
 * guess: the screen says the recipe excludes no hold, and ticking `agent:hold`
 * back into the excludes is one action away on that same screen. The label need
 * not exist on GitHub yet, which is why nothing creates it: a label is created
 * the first time it is applied.
 */
export const HOLD_LABEL = "agent:hold";

export function holdLabel(recipe: Recipe): string | null {
  return recipe.source.exclude.includes(HOLD_LABEL) ? HOLD_LABEL : null;
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
 * **The label is added by GitHub, not by a set this code computed.** `setLabels`
 * replaces (`client.ts:164`), which is right for a state Lingtai computes and
 * wrong for this: read the labels, append one, write the set back and every
 * label added in between is silently taken off — and on a thirty-issue
 * repository the loop runs for tens of seconds, so *in between* is an ordinary
 * afternoon, a colleague adding `needs-info` to an issue further down the list.
 * It would not appear in `failed` either; the issue would be reported held.
 * `POST issues/:n/labels` is set union performed by GitHub against whatever the
 * issue carries at that instant, so there is no set here to be stale, and a
 * label already present is not an error. Union is the wrong shape for a
 * transition and the right shape for this: a hold a person is applying adds one
 * label and touches nothing else.
 *
 * One at a time, and a refusal on one does not stop the rest. Thirty parallel
 * writes is how an installation meets a secondary rate limit, and a screen that
 * reports *nine held, one refused* is more use than one that reports a single
 * error over an unknown prefix of the list.
 */
export async function holdAll(options: HoldAllOptions): Promise<HoldAllResult> {
  const { client } = options;
  const result: HoldAllResult = { held: [], failed: [] };
  for (const ref of options.issues) {
    const n = Number(ref);
    try {
      await client.request("POST", `/repos/${client.owner}/${client.repo}/issues/${n}/labels`, {
        labels: [options.label],
      });
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
 * **The only write the wizard makes of its own accord** — `Hold all` beside it
 * is the operator's, and it has already run if they pressed it — and the order
 * inside it is `lingtai add`'s rule at a smaller scale: everything that can
 * refuse, refuses before anything is written:
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
 * **Between those two there is a window, and this is the one function that can
 * close it.** The pull request is open and the append has not happened — the
 * database blinked, or a concurrent `lingtai add` moved the stream under the
 * expected version — and the log knows nothing, so the board draws no pending
 * card and offers no `Recheck`. Merging that pull request appends nothing
 * either: only this function does. So the window is closed on the way back in
 * rather than by asking a person to delete a branch — step 3 finishes a pull
 * request it recognises as its own instead of refusing it, and a failure to
 * append is a refusal that names the open pull request and says another press
 * is what picks it up.
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
    // A branch of this name with the recipe on it and a pull request open is
    // not somebody else's work — it is this function's, interrupted between
    // the pull request and the append. Adopting it is the only way out: the
    // event is the one thing missing, and nothing but this appends it.
    const ours = (await client.fileAt(RECIPE_PATH, branch)) !== null;
    const open = ours ? await openPullRequest(client, branch) : null;
    if (open === null) {
      return {
        ok: false,
        refusal:
          `${slug} already has a branch called ${branch} with no onboarding pull request ` +
          "open on it — delete the branch, then press this again.",
      };
    }
    return record({
      store,
      stream,
      expected: existing.length,
      by: options.by,
      slug,
      base,
      pr: open,
      branch,
    });
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

  return record({
    store,
    stream,
    expected: existing.length,
    by: options.by,
    slug,
    base,
    pr,
    branch,
  });
}

/**
 * The append, and the refusal that keeps its failure recoverable.
 *
 * A throw here — the store unreachable, or a `ConcurrencyError` because
 * something appended to this stream between the read at the top and now — used
 * to leave `startOnboarding` throwing over an open pull request: the operator
 * told onboarding failed, the log empty, so no pending card and no `Recheck`,
 * and the branch check refusing every further press. It is a refusal instead,
 * and it says the two things that state needs said — the pull request exists,
 * and pressing again is what finishes it, because the branch check now adopts
 * that pull request rather than pointing at it.
 */
async function record(at: {
  store: EventStore;
  stream: string;
  expected: number;
  by: string;
  slug: string;
  base: string;
  pr: { number: number; url: string };
  branch: string;
}): Promise<Started> {
  try {
    await at.store.append(at.stream, at.expected, [
      {
        type: "ProjectOnboardingStarted",
        actor: at.by,
        data: parsePayload("ProjectOnboardingStarted", { slug: at.slug, base: at.base, by: at.by }),
      },
    ]);
  } catch (err) {
    return {
      ok: false,
      refusal:
        `${at.slug}'s pull request is open — ${at.pr.url} — and onboarding was not recorded: ` +
        `${(err as Error).message}. Press this again; it picks up the pull request on ${at.branch} ` +
        "rather than opening a second one.",
    };
  }
  return { ok: true, pr: at.pr, branch: at.branch };
}

/**
 * The open pull request on a branch, or null when there is none.
 *
 * Asked of GitHub rather than remembered, because the state it exists to
 * recognise is the one where nothing was written down.
 */
async function openPullRequest(
  client: GitHubClient,
  branch: string,
): Promise<{ number: number; url: string } | null> {
  const head = encodeURIComponent(`${client.owner}:${branch}`);
  const open = await client.request<{ number: number; html_url: string }[]>(
    "GET",
    `/repos/${client.owner}/${client.repo}/pulls?state=open&head=${head}`,
  );
  const first = open[0];
  return first === undefined ? null : { number: first.number, url: first.html_url };
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
