/**
 * `lingtai add <owner>/<repo>` — the whole of onboarding.
 *
 * Give it a repository slug and permissions; it does the rest. What it does
 * *not* do is take a configuration file: the recipe is this machine's,
 * `~/.lingtai/<project>/recipe.yml`, and nothing is read from or written to the
 * repository for it (0046 §3, #180).
 *
 * **`governing` below has no caller outside its tests.** It is 0005's read from
 * a branch, and since #180 neither `add` nor the board's `Recheck` reads a
 * recipe from a branch. Nothing depends on it; it is not a thing to extend.
 *
 * The order matters. Permissions are checked *before* anything is written, so a
 * half-onboarded project is not a state that exists. The failure this guards
 * against is specific: a fine-grained PAT that covered the admin repository's
 * submodule but not the repository itself produced a day of 403s on CI, and
 * nothing anywhere said "wrong scope".
 *
 * The base is not this command's to decide, and `--base` is not a second way of
 * deciding it (#75). The recipe's own `repo.base` says what the base *is*.
 * Given no flag, or a remembered base, this adopts it; given a flag the recipe
 * contradicts, it refuses and names both, because a person typed something
 * specific and must not be silently overridden.
 *
 * **In the conductor rather than in the CLI, because it has two callers**
 * (#163). The board's `Recheck` finishes a pending project (#182) by checking
 * the installation, reading the machine's recipe and appending
 * `ProjectConfigured` — which is
 * precisely this function, and a second implementation of it behind a button
 * would be two ways of registering a project, free to disagree about the base,
 * the permissions checked, or what is said when there is still no recipe there.
 * `lingtai add` is still the command; this is what it runs. What the button
 * replays is the base the wizard recorded, and it arrives as the hint it is
 * rather than as a flag — `resumeOnboarding` below is that whole distinction.
 */
import { type Envelope, type ProjectState, isRegistered, projectStream, reduceProject } from "@lingtai/domain";
import {
  RECIPE_PATH,
  type ReadAtRef,
  RecipeMissingError,
  type ResolvedRecipe,
  baseDivergence,
  parseDuration,
  projectLimits,
  recipePath,
  resolveLocalRecipe,
  resolveRecipe,
} from "@lingtai/recipe";
import { signedInHere } from "./projects.ts";
import { GATE_POINTS, type Tier, parsePayload } from "@lingtai/domain";
import {
  type Installation,
  NotInstalledError,
  createGitHubClient,
  installationForRepo,
  parseSlug,
  permissionGaps,
} from "@lingtai/github";
import { githubApp } from "@lingtai/env";
import { eventStore } from "@lingtai/event-store";
import { passCeiling } from "./filter.ts";

export interface AddOptions {
  slug: string;
  /**
   * Where to *read the recipe from* — a bootstrap hint, not the base. The
   * recipe's `repo.base` decides that, and a `--base` disagreeing with it is
   * refused rather than obeyed (#75). Defaults to the repository's own default
   * branch.
   *
   * `named` is whether a **person** said this branch, and it is the whole of
   * what earns that refusal: a typed `--base` must not be silently overruled,
   * and the way out of it is to re-run without the flag. A branch this system
   * *remembered* — the base a `ProjectOnboardingStarted` recorded, replayed by
   * the board's `Recheck` (#163) — is not named and must not be refused:
   * there is no flag for a button to omit, so the refusal would be permanent
   * and its advice would name something nobody typed. Remembered, the recipe's
   * `repo.base` is adopted from it exactly as it is from the default branch.
   */
  base?: { ref: string; named: boolean };
  /**
   * The installation, when the caller has already asked GitHub for it —
   * `recheck` has, and a second request would ask the same question twice.
   */
  installation?: Installation;
  /** Containment floor. `guarded` is what the first project runs at (0007). */
}

/**
 * What finishing a recorded onboarding asks `add` for (#163).
 *
 * One function rather than an object literal at the call site, because the
 * field that matters is the one easiest to get wrong. The board's `Recheck` has
 * a `ProjectOnboardingStarted` and nothing else: the base on it was filled from
 * GitHub's default branch by the wizard, which makes it *exactly* the bootstrap
 * hint `--base` is not. Sent as a named base it would be refused for ever the
 * moment a review corrected `repo.base` in the recipe PR — the card advising an
 * operator to re-run without a flag that a button cannot omit. Sent as what it
 * is, the recipe decides the base, which is #75's rule and not an exception to
 * it.
 */
export function resumeOnboarding(recorded: {
  owner: string;
  project: string;
  base: string;
}): AddOptions {
  return { slug: `${recorded.owner}/${recorded.project}`, base: { ref: recorded.base, named: false } };
}

/** What pressing `Recheck` came to, in the sentences a person reads. */
export type Rechecked =
  | { ok: true; detail: string }
  | { ok: false; installed: boolean; detail: string };

export interface RecheckDeps {
  /** `installationForRepo` against the App this machine has. */
  installation: (owner: string, repo: string) => Promise<Installation>;
  /** `add`. */
  register: (options: AddOptions, log: (line: string) => void) => Promise<number>;
}

/**
 * `Recheck`: is the App still installed on this repository, and if so, register
 * it (#182).
 *
 * **Pending waits for `Recheck`, not for a recipe landing in the repository**,
 * which 0046 §3 made impossible. And **not for an installation either**: the
 * wizard writes the recipe on this machine and records the project only through
 * a client built on the App's installation there, and refuses without one — so
 * every pending project had one when it was recorded. What can still refuse is
 * what `add` checks: the installation's permissions, the machine's recipe
 * (`~/.lingtai/config.yml` edited into something invalid since), and the
 * installation itself if it has been removed since. The installation is asked
 * first, and a repository the App can no longer see is answered in its own
 * sentence with nothing written, the card left where it was.
 *
 * Installed, it is `add` with the recorded base as the hint it is
 * (`resumeOnboarding`) and the installation just read, so GitHub is asked once:
 * the scopes, the machine's recipe, `ProjectConfigured`. Nothing here, and
 * nothing `add` does, writes to the repository.
 */
export async function recheck(
  recorded: { owner: string; project: string; base: string },
  deps: RecheckDeps = {
    installation: (owner, repo) => installationForRepo(githubApp(), owner, repo),
    register: add,
  },
): Promise<Rechecked> {
  const slug = `${recorded.owner}/${recorded.project}`;
  let installation: Installation;
  try {
    installation = await deps.installation(recorded.owner, recorded.project);
  } catch (err) {
    if (!(err instanceof NotInstalledError)) throw err;
    return {
      ok: false,
      installed: false,
      detail:
        `the GitHub App is not installed on ${slug} — install it on that repository ` +
        "(Settings → GitHub Apps → Configure), then press Recheck. Nothing was written.",
    };
  }

  const said: string[] = [];
  const code = await deps.register(
    { ...resumeOnboarding(recorded), installation },
    (line) => said.push(line),
  );
  if (code === 0) return { ok: true, detail: `${recorded.project} is live` };
  // **Everything it said, not the last line.** A permission gap is one line per
  // scope with what each is for; a rule here about which line is the refusal
  // would have to know which failure it was, and would be wrong the first time
  // `add` grows another. This is the transcript a person would have read in
  // the terminal.
  const why = said.filter((l) => l.trim() !== "").join("\n");
  return {
    ok: false,
    installed: true,
    detail: why === "" ? `${recorded.project} could not be registered` : why,
  };
}

/** The recipe that governs, or the reason this command will not pick one. */
export type Governing =
  | { ok: true; resolved: ResolvedRecipe; adoptedFrom: string | null }
  | { ok: false; refusal: string };

/**
 * Find the recipe from a branch; take the base from the recipe.
 *
 * `from.ref` is only where to look. What comes back is resolved at
 * `recipe.repo.base` and nowhere else, so the base recorded by `lingtai add` is
 * a copy of the file's and never a second decision beside it (#75). Three
 * outcomes, one per row of the ticket's table:
 *
 * - the file at `from.ref` declares that same branch — nothing to reconcile;
 * - it declares another and nobody named `from.ref` — bootstrap: read it again
 *   there, and take that;
 * - it declares another and a person named `from.ref` — refuse. Two people have
 *   now stated the base, and only one of them owns that decision under
 *   [0005](../../../doc/decisions/0005-config-in-target-repo.md); this command
 *   is not entitled to overrule either of them silently.
 *
 * The first read throws (`RecipeMissingError`, `RecipeInvalidError`) so the
 * caller can say the "nothing named a base" sentence about it. The second is
 * returned as a refusal instead: it is a branch this command chose to follow,
 * and the message has to say that is what happened.
 */
export async function governing(
  read: ReadAtRef,
  from: { ref: string; named: boolean },
  slug: string,
): Promise<Governing> {
  const resolved = await resolveRecipe(read, from.ref);
  const declared = resolved.recipe.repo.base;
  if (declared === from.ref) return { ok: true, resolved, adoptedFrom: null };

  if (from.named) {
    return {
      ok: false,
      refusal:
        `--base ${from.ref}, but ${RECIPE_PATH} there declares repo.base: ${declared}. ` +
        "--base says which branch to read the recipe from; repo.base says which branch " +
        "it governs, and this command will not overrule either. " +
        `Re-run without --base to take ${declared} from the recipe, ` +
        `or fix repo.base on ${from.ref}.`,
    };
  }

  let atDeclared: ResolvedRecipe;
  try {
    atDeclared = await resolveRecipe(read, declared);
  } catch (err) {
    return {
      ok: false,
      refusal:
        `${RECIPE_PATH} on ${from.ref} declares repo.base: ${declared}, ` +
        `so the recipe was read from ${declared} — ${(err as Error).message}`,
    };
  }
  // The file it points at has to point at itself. A chain is not a bootstrap:
  // one hop is "the default branch is not the base", two is a recipe that
  // disagrees with the branch it is on, which is `baseDivergence` exactly.
  const divergence = baseDivergence(atDeclared, slug);
  if (divergence) return { ok: false, refusal: divergence };
  return { ok: true, resolved: atDeclared, adoptedFrom: from.ref };
}

export async function add(options: AddOptions, log = console.log): Promise<number> {
  const { owner, repo } = parseSlug(options.slug);
  const auth = githubApp();

  // 1. Is the App installed here at all? This is the question a PAT cannot be
  //    asked, and the reason 0006 chose an App.
  let installation = options.installation;
  try {
    installation ??= await installationForRepo(auth, owner, repo);
  } catch (err) {
    if (err instanceof NotInstalledError) {
      log(err.message);
      return 1;
    }
    throw err;
  }
  log(`installation ${installation.id} on ${installation.account} (${installation.repositorySelection})`);

  // 2. Does it grant what Lingtai actually needs? Named individually, with
  //    what each one is for — a gap here becomes a 403 in the middle of a merge.
  const gaps = permissionGaps(installation);
  if (gaps.length > 0) {
    log("the installation is missing permissions:");
    for (const g of gaps) log(`  ${g.name}: have ${g.have}, need ${g.need} — ${g.why}`);
    log("Fix them in the App's settings, then re-run.");
    return 1;
  }
  log("permissions: issues, contents, pull requests write; metadata read");

  const client = await createGitHubClient({ auth, owner, repo, installation });
  log(`reading ${recipePath(repo)} — the recipe is this machine's, and nothing is read from the repository (0046 §3)`);

  // 3. The recipe, and with it the base — which is the recipe's, not this
  //    command's. A `--base` a person typed and the file contradicts is refused
  //    by name rather than overruled (#75); a remembered one is a hint, and the
  //    file's `repo.base` is adopted over it (#163).
  let resolved: ResolvedRecipe;
  try {
    resolved = await resolveLocalRecipe(repo, { signedIn: signedInHere });
  } catch (err) {
    log((err as Error).message);
    return 1;
  }
  if (options.base?.named && options.base.ref !== resolved.recipe.repo.base) {
    log(
      `--base ${options.base.ref}, but ${recipePath(repo)} declares repo.base: ${resolved.recipe.repo.base}. ` +
        "This command will not overrule either — re-run without --base to take the recipe's, " +
        "or fix repo.base in the file.",
    );
    return 1;
  }
  // Past this point these are one branch, and this one is the file's.
  const base = resolved.recipe.repo.base;
  log(`base: ${base} — the recipe's repo.base`);
  for (const [key, from] of Object.entries(resolved.provenance ?? {})) {
    if (key.startsWith("runtime.")) log(`  ${key.padEnd(24)} ${from}`);
  }

  const fromSha = await client.refSha(base);
  log(`recipe: ${recipePath(repo)} for ${base}@${fromSha.slice(0, 7)} — hash ${resolved.configHash.slice(0, 12)}`);
  // All five points, including the empty ones. Onboarding is the first place a
  // person sees the shape of their workflow, and a point that is not mentioned
  // is exactly the thing that must not be invisible (ADR 0016 §4).
  //
  // From `GATE_POINTS` rather than a list written here, which is what that
  // tuple is exported for: this line had its own copy of the five names, and
  // renaming one of them (0018) would have left onboarding printing a point
  // that no longer exists.
  for (const point of GATE_POINTS) {
    const actions = resolved.recipe.gates[point];
    log(`  ${point.padEnd(9)} ${actions.length ? actions.map((a) => a.name).join(", ") : "(skipped)"}`);
  }
  // Printed here for the reason the empty points above are: a policy that is
  // only visible when it fires is one nobody can audit, and this one spends an
  // agent's worth of money on a failure without being asked again
  // ([0025](../../../doc/decisions/0025-a-failure-buys-one-agent.md) §2).
  //
  // **The product, not the numbers that make it**
  // ([0039](../../../doc/decisions/0039-the-worktree-is-the-whole-of-a-pass.md) §3).
  // There were two ceilings here and they were printed side by side, which told
  // a reader everything except the thing being decided: what one pass of this
  // project can cost. One sentence, from `passCeiling`, so this line and the
  // drain's cannot say different things about the same recipe.
  const limits = projectLimits(resolved.recipe);
  log(`  ${"a pass".padEnd(9)} ${passCeiling({
    ...limits,
    wallMs: parseDuration(limits.wall),
  })}`);
  log(`  runtime ${resolved.recipe.runtime.agent}, kinds ${resolved.recipe.source.kinds.join(" > ")}`);

  log(`  tier ${resolved.recipe.runtime.tier}`);

  const stream = projectStream(repo);
  const existing = await eventStore.read(stream);
  await eventStore.append(stream, existing.length === 0 ? 0 : existing[existing.length - 1]!.version, [
    {
      type: "ProjectConfigured",
      actor: "conductor",
      data: parsePayload("ProjectConfigured", {
        project: repo,
        owner,
        // A copy of the recipe's `repo.base`, not a decision taken beside it
        // (#75). Recorded rather than re-derived because a run must not have to
        // ask GitHub which branch governs it; later drift is caught by the run's
        // own refusal rather than manufactured here.
        base,
        configHash: resolved.configHash,
        fromSha,
      }),
    },
  ]);

  log(registrationLine(existing, repo, resolved));
  return 0;
}

/**
 * The last line: *added*, or *updated* (#163).
 *
 * The question is whether this project was ever **configured**, and not whether
 * its stream has anything on it. A repository the wizard recorded already has
 * one event — `ProjectOnboardingStarted` — and has never been configured at
 * all, so counting events reports the first registration of every
 * wizard-onboarded repository as an update and swallows the tier-and-gates
 * summary onboarding exists to print. `isRegistered` is the line
 * `loadProjects` already draws, asked of the stream as it stood before this
 * append.
 */
export function registrationLine(
  prior: readonly Envelope[],
  repo: string,
  resolved: ResolvedRecipe,
): string {
  const before: ProjectState = reduceProject(prior);
  return isRegistered(before)
    ? `updated ${repo} — its ${prior.length} earlier event(s) are still on the record`
    : `added ${repo} — tier ${resolved.recipe.runtime.tier}, ${Object.values(resolved.recipe.gates).flat().length} action(s) across 5 gates`;
}
