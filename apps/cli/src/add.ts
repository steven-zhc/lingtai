/**
 * `lingtai add <owner>/<repo>` — the whole of onboarding.
 *
 * Give it a repository slug and permissions; it does the rest. What it does
 * *not* do is take a configuration file: the recipe belongs to the managed
 * repository and is read from its base branch. That split is
 * doc/decisions/0005-config-in-target-repo.md, and it is why this command needs
 * so few arguments.
 *
 * The order matters. Permissions are checked *before* anything is written, so a
 * half-onboarded project is not a state that exists. The failure this guards
 * against is specific: a fine-grained PAT that covered the admin repository's
 * submodule but not the repository itself produced a day of 403s on CI, and
 * nothing anywhere said "wrong scope".
 *
 * The base is not this command's to decide, and `--base` is not a second way of
 * deciding it (#75). There is one irreducible need for a branch from outside the
 * file — **you have to be on a branch to read the file at all** — so `--base`
 * says where to *find* the recipe, and the recipe's own `repo.base` says what
 * the base *is*. Given no flag, this bootstraps from the repository's default
 * branch and adopts the `repo.base` it finds; given a flag the recipe
 * contradicts, it refuses and names both, because a person typed something
 * specific and must not be silently overridden.
 */
import { projectStream } from "@lingtai/domain";
import {
  RECIPE_PATH,
  type ReadAtRef,
  RecipeMissingError,
  type ResolvedRecipe,
  baseDivergence,
  parseDuration,
  resolveRecipe,
} from "@lingtai/recipe";
import { GATE_POINTS, type Tier, parsePayload } from "@lingtai/domain";
import {
  NotInstalledError,
  createGitHubClient,
  installationForRepo,
  parseSlug,
  permissionGaps,
} from "@lingtai/github";
import { githubApp } from "@lingtai/env";
import { eventStore } from "@lingtai/event-store";
import { passCeiling } from "@lingtai/conductor";

export interface AddOptions {
  slug: string;
  /**
   * Where to *read the recipe from* — a bootstrap hint, not the base. The
   * recipe's `repo.base` decides that, and a `--base` disagreeing with it is
   * refused rather than obeyed (#75). Defaults to the repository's own default
   * branch.
   */
  base?: string;
  /** Containment floor. `guarded` is what the first project runs at (0007). */
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
  let installation;
  try {
    installation = await installationForRepo(auth, owner, repo);
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
  const fromDefault = options.base === undefined;
  const readFrom = options.base ?? (await client.defaultBranch());
  // Said *before* the read, not after it. When this is the wrong branch the
  // failure is otherwise a sentence about a file, and the reader has to work
  // out for themselves that the branch is the surprising part.
  log(`reading ${RECIPE_PATH} from ${readFrom}${fromDefault ? " (the repository's default branch)" : ""}`);

  // 3. The recipe, and with it the base — which is the recipe's, not this
  //    command's. Refused *before* anything is written when the two cannot be
  //    reconciled, the same way the permissions above are: a project whose rules
  //    come from one branch and whose merges go to another is not a state that
  //    exists. It is otherwise created here in silence and only ever paid for by
  //    a run, which obeys the wrong branch's gates and records nothing amiss.
  let found: Governing;
  try {
    found = await governing(
      (path, ref) => client.fileAt(path, ref),
      { ref: readFrom, named: !fromDefault },
      `${owner}/${repo}`,
    );
  } catch (err: unknown) {
    if (!(err instanceof RecipeMissingError)) throw err;
    log(err.message);
    if (fromDefault) {
      // The overwhelmingly common cause: a repository whose default branch is
      // not the branch it merges into. `nextloom-ai-admin`'s default is a
      // feature branch, and the recipe lives on `develop`.
      log("");
      log(`Nothing named a base, so this looked on ${readFrom} — the repository's default branch.`);
      log("`--base` says which branch to read the recipe *from*; the recipe's own");
      log("repo.base still says which branch it governs. If the file is elsewhere:");
      log(`  lingtai add ${owner}/${repo} --base <branch>`);
    }
    return 1;
  }
  if (!found.ok) {
    log(found.refusal);
    return 1;
  }
  const resolved = found.resolved;
  // Past `governing` these are one branch, and this one is the file's.
  const base = resolved.recipe.repo.base;
  log(
    `base: ${base} — the recipe's repo.base` +
      (found.adoptedFrom ? `, adopted from the file on ${found.adoptedFrom}` : ""),
  );

  const fromSha = await client.refSha(base);
  log(`recipe: ${RECIPE_PATH} at ${base}@${fromSha.slice(0, 7)} — hash ${resolved.configHash.slice(0, 12)}`);
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
  log(`  ${"a pass".padEnd(9)} ${passCeiling({
    ...resolved.recipe.runtime.limits,
    wallMs: parseDuration(resolved.recipe.runtime.limits.wall),
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

  log(
    existing.length === 0
      ? `added ${repo} — tier ${resolved.recipe.runtime.tier}, ${Object.values(resolved.recipe.gates).flat().length} action(s) across 5 gates`
      : `updated ${repo} — its ${existing.length} earlier event(s) are still on the record`,
  );
  return 0;
}
