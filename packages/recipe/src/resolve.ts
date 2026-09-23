/**
 * Resolving a recipe: parse it, validate it, hash it.
 *
 * **Where the text comes from is not this file's any more.** A run is governed
 * by `~/.lingtai/<project>/recipe.yml`, read by `resolveLocalRecipe` in
 * `local.ts` through `resolveSource` below
 * ([0046](../../../doc/decisions/0046-lingtai-is-personal.md) §3, #180). Nothing
 * reads `.lingtai/config.yaml` from a managed repository to run anything, so
 * editing or merging that file changes no run, and `tamper` has nothing there
 * to catch.
 *
 * `resolveRecipe` and `ReadAtRef` remain for the readers that still have a
 * file at a ref in hand: the task page proving a run recorded before the move
 * against its base commit, the wizard checking the bytes it is about to write,
 * and tests. 0005's rule — *read from the base branch, never the branch being
 * judged* — was what made a recipe inside the repository safe; it now holds by
 * location, because an agent's worktree does not contain `~/.lingtai/`.
 */
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { applyPreset } from "./presets.ts";
import { Recipe } from "./recipe.ts";

/** Where a project's recipe lives, by convention and without exception. */
export const RECIPE_PATH = ".lingtai/config.yaml";

/** Reads a path at a ref. Returns null when the file is not there. */
export type ReadAtRef = (path: string, ref: string) => Promise<string | null>;

export class RecipeMissingError extends Error {
  override readonly name = "RecipeMissingError";
  readonly ref: string;

  constructor(ref: string, message?: string) {
    super(
      message ??
        `no ${RECIPE_PATH} on ${ref}. Add one and commit it to that branch — ` +
          "a recipe on the agent's branch is not read, by design.",
    );
    this.ref = ref;
  }
}

export class RecipeInvalidError extends Error {
  override readonly name = "RecipeInvalidError";
  /** Each problem as `path: message`, so a fix does not need a schema reading. */
  readonly problems: readonly string[];

  constructor(ref: string, problems: readonly string[], where = `${RECIPE_PATH} on ${ref}`) {
    super(`${where} is not valid:\n  ${problems.join("\n  ")}`);
    this.problems = problems;
  }
}

export interface ResolvedRecipe {
  recipe: Recipe;
  /**
   * Hash of the *resolved* recipe, canonically serialised.
   *
   * Of the resolved form rather than the file's bytes: two files that differ
   * only in comments or key order describe the same run, and a replay comparing
   * "did results change after I edited the pipeline?" should say no. Recorded in
   * `ProjectConfigured` and in every `RunStarted`.
   */
  configHash: string;
  /** The ref it was read from — always a base branch, never an agent branch. */
  ref: string;
  /** The raw file, kept so a diff against a later version is possible. */
  source: string;
  /** The tier this run will execute at. The recipe's, and now nobody else's. */
  tier: Recipe["runtime"]["tier"];
  /** Which preset it extended, if any. Provenance; not part of the hash. */
  preset: string | null;
  /**
   * Where each value a person might ask about came from — the recipe file, the
   * machine file, detection or a default — keyed by its path in the recipe.
   * Only a recipe read from this machine has one (`resolveLocalRecipe`).
   */
  provenance?: Readonly<Record<string, string>>;
}

/** Stable JSON: keys sorted at every level, so the hash does not depend on order. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

/**
 * The five steps [0058](../../../doc/decisions/0058-lingtai-is-a-development-pipeline.md)
 * §3 added on 2026-09-23, left out of the canonical form while they are empty.
 *
 * **A hash cannot be upcast, which is the whole of why this is here.** A
 * `configHash` is the identity of a document
 * ([0047](../../../doc/decisions/0047-the-recipe-a-run-got-is-on-the-log.md) §2:
 * *two documents with one hash are one document*), and the log is full of
 * hashes taken when `gates` had five keys. Widening `GateMap` to ten put five
 * more always-empty keys inside `canonical`, so the identical `recipe.yml`
 * hashed to something new — and there is no step from an old digest to a new
 * one the way `GatesResolved`'s `3 → 4` has one for a stored plan. The task
 * page proves an attempt's recipe by comparing its recorded hash to the file
 * at the run's base commit (`apps/board/src/lib/recipe.ts`), so every attempt
 * already in the record would fail that comparison and be told, in a refusal,
 * that the recipe at its base differs — about bytes that never changed.
 *
 * **Nothing is lost by leaving them out.** `KINDS_AT` refuses every kind at all
 * five, so a resolving recipe's list at one of them is *always* `[]` — the
 * canonical form is dropping a field that carries no information. The day
 * 0058's plan builds one and a recipe configures it, the list is non-empty, it
 * is in the hash, and the hash changes because the configuration did.
 *
 * It dies where the nine upcasters die: [0061](../../../doc/decisions/0061-the-recipe-is-the-pipeline.md)
 * §7's reset ([the-pipeline](../../../doc/design/the-pipeline.md)'s T5) leaves
 * no stored hash to keep faith with, and this list comes down with them.
 */
const NOT_YET_IN_THE_HASH = ["claim", "design", "implement", "build", "review"] as const;

/**
 * The recipe as it is hashed: the five steps above dropped where they are
 * empty, which today is always.
 *
 * Both `canonicalRecipe` and `hashRecipe` go through it, because the body on
 * the event and the digest beside it have to be the same document — 0047 §2's
 * *a reader can verify the body without trusting the writer* is `hashRecipe`
 * of the recorded body equalling the recorded hash, and a strip on one side
 * only would break it.
 *
 * **Idempotent, and that is what makes the verification work.** The reader in
 * `conductor/unit/recorded-recipe.test.ts` hands `hashRecipe` the body off the
 * event, which has already been through here, so the five keys are gone rather
 * than empty — a missing one is *also* nothing configured there, and must be
 * left alone rather than read for a length it does not have.
 */
function forHash(recipe: Recipe): Record<string, unknown> {
  const gates: Record<string, unknown> = { ...recipe.gates };
  for (const step of NOT_YET_IN_THE_HASH) {
    if ((gates[step] as readonly unknown[] | undefined)?.length === 0) delete gates[step];
  }
  return { ...recipe, gates };
}

/**
 * The recipe as `hashRecipe` sees it, as an object rather than a string: what
 * `GatesResolved` records beside the hash (0047 §2). The body and its hash on
 * one event is what lets a reader verify the body without trusting the writer —
 * `hashRecipe` of this is the `configHash` of the recipe it came from.
 */
export function canonicalRecipe(recipe: Recipe): Record<string, unknown> {
  return JSON.parse(canonical(forHash(recipe))) as Record<string, unknown>;
}

export function hashRecipe(recipe: Recipe): string {
  return createHash("sha256").update(canonical(forHash(recipe))).digest("hex");
}

/**
 * Reads and validates the recipe at a ref.
 *
 * Throws rather than returning a result type: every caller's correct response to
 * an unreadable recipe is to stop, and a project that cannot be configured must
 * not be silently run with a default.
 */
export async function resolveRecipe(
  read: ReadAtRef,
  ref: string,
): Promise<ResolvedRecipe> {
  const source = await read(RECIPE_PATH, ref);
  if (source === null) throw new RecipeMissingError(ref);
  return resolveSource(source, ref, `${RECIPE_PATH} on ${ref}`);
}

/**
 * The half of `resolveRecipe` that does not care where the text came from.
 *
 * `where` is how a refusal names the file; `shape` runs on the parsed YAML
 * before the preset and may refuse keys by name or fill fields in — which is
 * how `resolveLocalRecipe` puts the machine's `runtime.agent` and
 * `runtime.limits` into a recipe that may not carry them itself.
 */
export function resolveSource(
  source: string,
  ref: string,
  where: string,
  shape: (raw: Record<string, unknown>) => string[] = () => [],
): ResolvedRecipe {
  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (err) {
    throw new RecipeInvalidError(ref, [`could not be parsed as YAML: ${(err as Error).message}`], where);
  }

  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const refused = shape(raw as Record<string, unknown>);
    if (refused.length > 0) throw new RecipeInvalidError(ref, refused, where);
  }

  // Preset first, then validation: a preset can satisfy a required field the
  // recipe omits, which is the point of having one.
  let applied;
  try {
    applied = applyPreset(raw);
  } catch (err) {
    throw new RecipeInvalidError(ref, [`extends: ${(err as Error).message}`], where);
  }

  const retired = retiredKeys(applied.recipe);
  if (retired.length > 0) throw new RecipeInvalidError(ref, retired, where);

  const parsed = Recipe.safeParse(applied.recipe);
  if (!parsed.success) {
    throw new RecipeInvalidError(
      ref,
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
      where,
    );
  }

  // The resolved form is what gets hashed, so the preset is inside the hash and
  // a preset change is a configuration change.
  return {
    recipe: parsed.data,
    configHash: hashRecipe(parsed.data),
    ref,
    source,
    tier: parsed.data.runtime.tier,
    preset: applied.preset,
  };
}

/**
 * Keys that used to mean something and now mean nothing, refused by name.
 *
 * `Recipe` is `z.object` and not `z.strictObject`, so a key it no longer knows
 * is **silently dropped** — and a repository that wrote `repair.maxAttempts: 3`
 * would go on running with `rounds`' default while its own file said otherwise.
 * That is the failure this project keeps finding under another name: a setting
 * present, believed, and not connected to anything.
 *
 * So the refusal is explicit, it names the replacement, and it happens before
 * validation — a recipe is a thing a person edits, and being told *this moved
 * to `runtime.limits.rounds`* is the difference between a two-minute fix and an
 * afternoon. Refusing rather than migrating is deliberate: the two old numbers
 * do not add up to the new one (0039 §3), so only the repository can say what
 * it meant.
 *
 * Removing an entry from here is safe once no recipe anywhere can still carry
 * the key; leaving one costs a string comparison per run.
 */
function retiredKeys(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null) return [];
  const out: string[] = [];
  if ("repair" in raw) {
    out.push(
      "repair: retired by ADR 0039 — `repair.maxAttempts`, `repair.fix` and `repair.on` " +
        "are now one number, `runtime.limits.rounds`, beside `turns` and `wall`. " +
        "`repair.on: false` is `rounds: 0`. Delete the `repair` block and say what this " +
        "repository wants a pass to spend; the two old ceilings do not add up to the new one, " +
        "so Lingtai will not guess",
    );
  }
  return out;
}

/**
 * The comparison nothing was making: does the recipe read from a ref name that
 * same ref as the branch it governs?
 *
 * Two different branches were both called "the base". `resolveRecipe` reads from
 * one — the branch recorded at `lingtai add` — and `repo.base` inside the file
 * it returns names another, which is what the worktree is cut from and what the
 * merge goes back into. When they disagree the run is right about everything
 * except the rules: it merges into `repo.base` under gates read from somewhere
 * else. A `human:` action at `merge` declared on one branch and not the other is
 * then a control that is declared and does not run.
 *
 * No audit after the fact can see that. `GatesResolved` is written from the same
 * recipe the run obeyed and carries that recipe's hash, so plan and execution
 * agree perfectly; it is the plan's *origin* that is wrong. Only this comparison,
 * made before anything is claimed, catches it — see
 * doc/decisions/0005-config-in-target-repo.md, which assumed one base.
 *
 * Returns the refusal rather than throwing, and never repairs: every caller says
 * it in its own vocabulary — a refused run stage, a failed onboarding, a red
 * doctor check — and none of them may pick a winner between the two branches.
 */
export function baseDivergence(resolved: ResolvedRecipe, slug: string): string | null {
  const declared = resolved.recipe.repo.base;
  if (declared === resolved.ref) return null;
  return (
    `recipe read from ${resolved.ref} declares repo.base: ${declared} — ` +
    "the rules and the merge target are different branches. " +
    `Re-register: lingtai add ${slug} --base ${declared}`
  );
}
