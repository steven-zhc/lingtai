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
 * Then `startOnboarding`: validate, write the recipe on this machine, append
 * `ProjectOnboardingStarted`. **It is the only write the wizard makes of its
 * own accord** — no file and no event exist before it — which is `lingtai
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
import { ConcurrencyError, type EventStore, eventStore } from "@lingtai/event-store";
import type { GitHubClient } from "@lingtai/github";
import { stateDir } from "@lingtai/env";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  Recipe,
  type Said,
  emitRecipe,
  machineFiles,
  machinePath,
  parseDuration,
  recipePath,
  resolveLocalRecipe,
  resolveRecipe,
} from "@lingtai/recipe";
import { passedOver, runnableNow } from "./discover.ts";
import { type Runnable, selectRunnable } from "./queue.ts";
import { nothingChecks } from "./wizard-page.ts";

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
 * sentence is said on the last screen, because that is where somebody is
 * deciding.
 */
export function nothingReadsIt(recipe: Recipe): string | null {
  if (recipe.gates.merge.length > 0) return null;
  if (recipe.gates.proposed.length > 0) return null;
  return nothingChecks(recipe.repo.base);
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

/** The recipe as a file, or the reason nothing will be written. */
export type Validated = { ok: true; file: string } | { ok: false; refusal: string };

/**
 * The generated recipe, parsed by the system's own parser before anything opens.
 *
 * A file written and then refused by `lingtai add` is a bad recipe on this
 * machine, where the next thing to read it is a run. So it is parsed
 * here, twice over and deliberately:
 *
 * - `Recipe.safeParse` on the value, which is what names the field. `source.kinds`
 *   has `.min(1)`, and *kinds: array must contain at least 1 element* is a
 *   sentence an operator can act on where a stack trace is not.
 * - `resolveRecipe` on the **bytes**, through the same parser `lingtai add`
 *   will use (`startOnboarding` then reads the files it writes back the way
 *   `add` reads them). What lands is a file, not a value, and between
 *   the two sits `emitRecipe` — a comment in the wrong place or a preset that
 *   will not apply is caught here rather than by a run.
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
  /** The repository: its owner and name. Nothing is asked of it and nothing is written to it. */
  client: GitHubClient;
  /** The recipe the wizard built. Its `repo.base` is the base the event records. */
  recipe: Recipe;
  /** The sentences the page showed, by dotted path — the file's comments. */
  said?: Said;
  /** Who pressed it — `human:<id>`. */
  by: string;
  /** `stateDir()` unless a test says otherwise. */
  home?: string;
  store?: EventStore;
}

export type Started = { ok: true; path: string } | { ok: false; refusal: string };

async function readIfThere(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * The button: validate, write the recipe on this machine, record that
 * onboarding started.
 *
 * **Nothing is written to the repository** (0046 §3, #180). The recipe is
 * `~/.lingtai/<project>/recipe.yml` and the agent and limits the page chose go
 * under `projects.<project>.runtime` in `~/.lingtai/config.yml` — the files
 * `Recheck`'s `lingtai add` reads — so a pending card is finished by pressing
 * `Recheck`, with no pull request for anybody to merge first. It used to open
 * one carrying `.lingtai/config.yaml`, which nothing reads any more.
 *
 * **The only write the wizard makes of its own accord** — `Hold all` beside it
 * is the operator's — and everything that can refuse, refuses before anything
 * is written:
 *
 * 1. the stream, because a repository already recorded must not collect a
 *    second `ProjectOnboardingStarted`;
 * 2. the recipe, by `validateProposal` above;
 * 3. a recipe already at that path that is not this one, which is a person's
 *    file and not this button's to overwrite — one that *is* this one is this
 *    function's own, interrupted before the append, and is picked up;
 * 4. the machine file, which may already name another runtime for the project;
 * 5. the bytes, resolved the way `lingtai add` will resolve them.
 *
 * Then the files, and then the event — last because it is the thing the board
 * reads, and a card offering `Recheck` for a recipe that was never written is a
 * state nobody can get out of.
 */
export async function startOnboarding(options: StartOnboardingOptions): Promise<Started> {
  const { client, recipe } = options;
  const store = options.store ?? eventStore;
  const home = options.home ?? stateDir();
  const slug = `${client.owner}/${client.repo}`;
  const base = recipe.repo.base;
  const stream = projectStream(client.repo);
  const path = recipePath(client.repo, home);
  const machineFile = machinePath(home);

  const existing = await store.read(stream);
  const state = reduceProject(existing);
  if (isRegistered(state)) {
    return { ok: false, refusal: `${slug} is already registered — its recipe is ${path}` };
  }
  if (isPending(state)) {
    return {
      ok: false,
      refusal:
        `${slug} is already on its way in — onboarding was recorded for it, and its recipe is ${path}. ` +
        "Press Recheck to finish it.",
    };
  }

  const validated = await validateProposal(recipe, options.said ?? {});
  if (!validated.ok) return { ok: false, refusal: validated.refusal };

  let files: ReturnType<typeof machineFiles>;
  let there: string | null;
  try {
    files = machineFiles({
      file: validated.file,
      recipe,
      project: client.repo,
      machine: await readIfThere(machineFile),
      home,
    });
    there = await readIfThere(path);
  } catch (err) {
    return { ok: false, refusal: `this machine's files could not be read: ${(err as Error).message}` };
  }
  if (!files.ok) return { ok: false, refusal: files.refusal };
  if (there !== null && there !== files.recipe) {
    return {
      ok: false,
      refusal:
        `there is already a recipe at ${path}, and it is not the one this page describes. Nothing was ` +
        "written — edit that file, or delete it and press this again.",
    };
  }

  // The bytes, read back the way `lingtai add` reads them — the agent is named
  // in the machine file now, so nothing is asked what is signed in.
  const planned = files;
  try {
    await resolveLocalRecipe(client.repo, {
      home,
      base,
      signedIn: async () => [],
      read: async (p) =>
        p === path ? planned.recipe : p === machineFile ? (planned.machine ?? readIfThere(p)) : readIfThere(p),
    });
  } catch (err) {
    return { ok: false, refusal: (err as Error).message };
  }

  try {
    await mkdir(dirname(path), { recursive: true });
    if (there === null) await writeFile(path, files.recipe);
    if (files.machine !== null) await writeFile(machineFile, files.machine);
  } catch (err) {
    return { ok: false, refusal: `the recipe was not written: ${(err as Error).message}` };
  }

  return record({ store, stream, expected: existing.length, by: options.by, slug, base, path });
}

/**
 * The append, and the refusal that keeps its failure recoverable.
 *
 * A throw here — the store unreachable, or a `ConcurrencyError` because
 * something appended to this stream between the read at the top and now —
 * would leave an operator told onboarding failed, with the log empty, so no
 * pending card and no `Recheck`, over a recipe already written. It is a
 * refusal instead, and it names the file, which exists whichever way the
 * append failed.
 *
 * **The two failures do not have the same way out, so they do not get the same
 * sentence.** A store that blinked leaves the stream where the read found it,
 * so pressing again finds the same file, picks it up and appends — *press this
 * again* is true. A `ConcurrencyError` is the stream having moved: a
 * concurrent `lingtai add` or a second press recorded this project, and the
 * next press stops at `isRegistered` or `isPending` without a word about the
 * file. So that refusal says what became of the project, says plainly that
 * pressing again will not finish it, and hands back the file as the thing left
 * to decide about.
 */
async function record(at: {
  store: EventStore;
  stream: string;
  expected: number;
  by: string;
  slug: string;
  base: string;
  path: string;
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
    const named = `${at.slug}'s recipe is written — ${at.path} — and onboarding was not recorded: ${(err as Error).message}.`;
    if (err instanceof ConcurrencyError) {
      return {
        ok: false,
        refusal:
          `${named} Something else recorded this project while the wizard was writing it, so pressing ` +
          `this again will not finish it — it will say ${at.slug} is already registered, or already on ` +
          `its way in. The file is still there, and it is what ${at.slug}'s runs obey once it is ` +
          `registered: keep it only if you want this recipe, and otherwise edit it or delete it.`,
      };
    }
    return {
      ok: false,
      refusal: `${named} Press this again; it picks up the recipe already at ${at.path} rather than writing another.`,
    };
  }
  return { ok: true, path: at.path };
}
