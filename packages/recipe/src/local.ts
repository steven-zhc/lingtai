/**
 * The recipe is mine: `~/.lingtai/<project>/recipe.yml`, and the machine's own
 * half beside it in `~/.lingtai/config.yml`
 * ([0046](../../../doc/decisions-archive/0046-lingtai-is-personal.md) §3,
 * [0104](../../../doc/decisions/0104-the-recipe-is-the-pipeline.md), `#371`).
 *
 * **The repository holds facts about itself; everything else is mine.** So the
 * recipe keeps `repo`, `source`, `env`, `steps`, `subscribers` and, since
 * `#371`, `runtime.limits` — what a pass may spend is a fact about how much
 * this repository's work is worth, which the steps decide and the machine does
 * not. `runtime.agent` is the one field that stays exiled: which CLI is
 * installed and signed in is a fact about this machine. **It moves; it does
 * not go** — 0007 supports two runtimes, both can be signed in at once, and a
 * choice nobody wrote down is the default this is here to refuse.
 *
 * **`runtime.limits` in the machine file now means two different things, by
 * where it is written** (`#371`):
 *
 * | Where | What it is | How it resolves |
 * |---|---|---|
 * | `projects.<p>.runtime.limits` | The ceiling's old home (`#180`–`#371`): the recipe's own number, written in the wrong file. | A fallback, per key, only where the recipe is silent. The first wizard save moves it into the recipe and deletes it here. |
 * | `runtime.limits` (machine-wide) | *What this machine will spend* — a metered account, a laptop on battery. The one argument that survives `#371`'s move. | Narrows the recipe's value, per key: the smaller of the two wins. Never a fallback, and never a way to raise it. |
 *
 * So a recipe silent about limits and a per-project block in the machine file
 * resolve to exactly what they resolved to before this ticket — nothing
 * refuses on the day it lands, and nothing changes until a wizard save moves
 * the numbers across.
 *
 * Nothing here makes a request. The file is read on every resolve, as the
 * branch was, so an edit reaches the next run and a daemon holds nothing stale.
 *
 * **Both files refuse what belongs in the other, by name.** A key silently
 * dropped and a key that does not exist are different facts to whoever wrote
 * it (0016 §4), and `steps` in the machine file is the one that matters: a step
 * that reads as declared and holds nothing is a way to weaken a gate quietly.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Document, isMap, parse as parseYaml, parseDocument } from "yaml";
import { z } from "zod";
import { RuntimeId } from "@lingtai/domain";
import { stateDir } from "@lingtai/env";
import { parseDuration } from "./duration.ts";
import { PRESETS } from "./presets.ts";
import { LIMIT_DEFAULTS, positiveDuration, type Recipe } from "./recipe.ts";
import { RecipeMissingError, type ResolvedRecipe, resolveSource } from "./resolve.ts";
import { assigneeOf, backoffOf, baseOf, ceilingOf, excludeOf, kindsOf } from "./settings.ts";

/** A project's recipe, under `stateDir()`. */
export function recipePath(project: string, home: string = stateDir()): string {
  return join(home, project, "recipe.yml");
}

/** This machine's own settings, under `stateDir()`. */
export function machinePath(home: string = stateDir()): string {
  return join(home, "config.yml");
}

/** The limits a machine may set. Every key optional: an absent one is the default, and says so. */
const MachineLimits = z.strictObject({
  turns: z.number().int().positive().optional(),
  /**
   * A duration, refused here rather than at the point of use.
   *
   * This is the file `wall` lives in since 0046 §3, so this is the file that
   * has to say `"90"` is not one — `Recipe`'s own check never sees this value
   * under its own key, and every reader downstream of the resolve is left
   * calling `parseDuration` on it and throwing somewhere that cannot name
   * either the key or the file (#218).
   */
  wall: z
    .string()
    .refine((text) => positiveDuration(text), { message: "must be a positive duration, like 2h" })
    .optional(),
  rounds: z.number().int().nonnegative().optional(),
  restarts: z.number().int().nonnegative().optional(),
  usd: z.number().positive().optional(),
});

/**
 * `runtime` in the machine file: the agent and the limits, and nothing else.
 * Strict, so `tier`, `prompt` or `budget` written here is refused rather than
 * dropped — those are about how this repository's work is run and stay in the
 * recipe.
 */
const MachineRuntime = z.strictObject({
  agent: RuntimeId.optional(),
  limits: MachineLimits.optional(),
});

/**
 * `~/.lingtai/config.yml`.
 *
 * Not strict at the top: this file is the machine's (ports, a database URL —
 * doc/design/1.0.md), and a section some other reader owns is not this
 * reader's to refuse. `steps` and `runtime.assignee` are refused anyway,
 * before the schema: `steps` because its silent absence weakens a gate, and
 * `runtime.assignee` because it moved to the recipe (`#373`) and a key
 * accepted here but never read is 0016 §4's failure under a new name.
 */
export const MachineConfig = z.object({
  runtime: MachineRuntime.optional(),
  /** Per project, over the machine-wide `runtime`: a person may want a different agent for one repository. */
  projects: z.record(z.string(), z.strictObject({ runtime: MachineRuntime.optional() })).optional(),
});
export type MachineConfig = z.infer<typeof MachineConfig>;

/** Which runtimes are signed in on this machine. Asked only when no file names one. */
export type SignedIn = () => Promise<readonly RuntimeId[]>;

export class MachineConfigInvalidError extends Error {
  override readonly name = "MachineConfigInvalidError";
  readonly problems: readonly string[];

  constructor(path: string, problems: readonly string[]) {
    super(`${path} is not valid:\n  ${problems.join("\n  ")}`);
    this.problems = problems;
  }
}

/** The runtime could not be decided without guessing. */
export class AgentUnresolvedError extends Error {
  override readonly name = "AgentUnresolvedError";
}

/**
 * **The live name, and only it, since `#247`.**
 *
 * `steps:` is where a pass is configured, and a block under it here is a person
 * who has put it in the wrong file — silently dropped without this, which is
 * 0016 §4's failure and the one this whole file exists to keep out. The
 * pre-0061 spelling was refused beside it until the log's vocabulary went; what
 * it was for was somebody copying an old block across, and it is one of the
 * four retired words, so it could not stay in `src/` and leave
 * `doc/reference.md`'s allowlist empty. A recipe under `version: 1` is still
 * refused by name, and by the version rather than by the key.
 */
function stepsRefusal(at: string, project: string, home: string): string {
  return (
    `${at}: a pass is not configured in the machine file — it is configured in the recipe, ` +
    `${recipePath(project, home)}, under \`steps:\`. Nothing here was applied; ` +
    "move the block there if it is meant to run"
  );
}

/**
 * **Since `#373`.** Whose tickets this project takes is the recipe's — under
 * `runtime.assignee`, or `assignee` in `claim`'s `queue:` — never the
 * machine's, so a machine file that still writes it is a person who has not
 * heard of the move, and a key accepted here but never read is exactly what
 * `stepsRefusal` exists to keep this file from doing silently.
 */
function assigneeRefusal(at: string, project: string, home: string): string {
  return (
    `${at}: whose tickets this project takes is not configured in the machine file — it is configured ` +
    `in the recipe, ${recipePath(project, home)}, under \`runtime.assignee\`, or \`assignee\` in \`claim\`'s ` +
    "`queue:`. Nothing here was applied; move it there if it is meant to apply"
  );
}

/** Whether `runtime.assignee` is written under `scope`, which is `top` or one `top.projects` entry. */
function hasAssignee(scope: Record<string, unknown>): boolean {
  const runtime = scope["runtime"];
  return runtime !== null && typeof runtime === "object" && !Array.isArray(runtime) && "assignee" in runtime;
}

/**
 * Parses the machine file's text. `null` is a machine with no file, which is a
 * machine that has set nothing.
 */
export function parseMachineConfig(
  text: string | null,
  path: string,
  project: string,
  home: string,
): MachineConfig {
  if (text === null) return {};
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new MachineConfigInvalidError(path, [`could not be parsed as YAML: ${(err as Error).message}`]);
  }
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new MachineConfigInvalidError(path, ["(root): expected a mapping"]);
  }

  const problems: string[] = [];
  const top = raw as Record<string, unknown>;
  if ("steps" in top) problems.push(stepsRefusal("steps", project, home));
  if (hasAssignee(top)) problems.push(assigneeRefusal("runtime.assignee", project, home));
  const projects = top["projects"];
  if (projects !== null && typeof projects === "object" && !Array.isArray(projects)) {
    for (const [name, scope] of Object.entries(projects as Record<string, unknown>)) {
      if (scope === null || typeof scope !== "object") continue;
      const scoped = scope as Record<string, unknown>;
      if ("steps" in scoped) problems.push(stepsRefusal(`projects.${name}.steps`, name, home));
      if (hasAssignee(scoped)) problems.push(assigneeRefusal(`projects.${name}.runtime.assignee`, name, home));
    }
  }
  if (problems.length > 0) throw new MachineConfigInvalidError(path, problems);

  const parsed = MachineConfig.safeParse(raw);
  if (!parsed.success) {
    throw new MachineConfigInvalidError(
      path,
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }
  return parsed.data;
}

/**
 * Which agent, and why that one.
 *
 * ```
 * a file names one                →  that one
 * absent, exactly one signed in   →  that one
 * absent, more than one           →  say so and ask; never pick silently
 * absent, none                    →  refuse by name
 * ```
 *
 * Detected is a default, not a replacement for being told: the refusal for
 * two says exactly what to write, so the answer is then written down.
 */
export async function resolveAgent(
  named: { agent: RuntimeId; from: string } | null,
  signedIn: SignedIn,
  path: string,
): Promise<{ agent: RuntimeId; from: string }> {
  if (named) return named;
  const detected = [...new Set(await signedIn())];
  if (detected.length === 1) return { agent: detected[0]!, from: "detected — the only runtime signed in" };
  if (detected.length > 1) {
    throw new AgentUnresolvedError(
      `${detected.join(" and ")} are all signed in on this machine, and ${path} names no runtime.agent — ` +
        `which one should run? Write \`runtime:\\n  agent: <${detected.join("|")}>\` in ${path}; ` +
        "Lingtai does not pick one silently",
    );
  }
  throw new AgentUnresolvedError(
    `no agent runtime is signed in on this machine, and ${path} names no runtime.agent — ` +
      "`lingtai doctor`'s `runtime: signed in` says what is missing",
  );
}

/**
 * How a provenance entry joins its value to where the value came from.
 *
 * Written once because two readers now split on it: `lingtai doctor` prints the
 * whole entry, and the board's recipe page prints the two halves in two columns
 * (#218). A separator spelled out in both places is one nobody can change.
 */
export const PROVENANCE_ARROW = " ← ";

/**
 * The `where` half of a provenance entry — `value ← where` — or null when the
 * entry says nothing about where it came from.
 *
 * Null rather than the whole entry: a reader that cannot find the source must
 * say it has none, not print the value a second time under a heading claiming
 * to be its origin.
 */
export function provenanceSource(entry: string | undefined): string | null {
  if (entry === undefined) return null;
  const at = entry.indexOf(PROVENANCE_ARROW);
  return at === -1 ? null : entry.slice(at + PROVENANCE_ARROW.length);
}

/**
 * Whether an object carries a dotted path at all — not what it says there.
 *
 * **A key with nothing under it carries nothing**, and that is `applyPreset`'s
 * rule rather than a convenience here: `recipe["steps"] ?? preset.steps` takes
 * the preset's for a `null` exactly as it does for an absent key, so a
 * `steps:` whose block has been commented out is a file that decided nothing
 * and must not be named as the source of what the preset decided (#218). The
 * intermediate segments have always read it this way; only the leaf did not.
 */
function carries(value: unknown, path: string): boolean {
  let at = value;
  for (const segment of path.split(".")) {
    if (at === null || typeof at !== "object" || Array.isArray(at)) return false;
    if (!(segment in (at as Record<string, unknown>))) return false;
    at = (at as Record<string, unknown>)[segment];
  }
  return at !== undefined && at !== null;
}

/**
 * Where a value in the resolved recipe came from: the file, the preset
 * underneath it, or the schema (#218).
 *
 * **Three origins and not two.** Every key here but `repo.base`, `source.kinds`
 * and `env.plantAt` has a schema default, and `steps` — the most consequential
 * of them, since it is what holds a run — can also come from a preset. A
 * resolved recipe reads the same in all three cases, so a reader told
 * `recipe.yml` for a `steps:` block that file does not contain opens it, finds
 * nothing, and cannot learn the answer anywhere: `extends: pnpm-workspace` is
 * a line about steps that never names them.
 *
 * **Asked at the level the merge happens at**, which is `applyPreset`'s rule
 * and not this function's invention: `repo` and `runtime` merge a key at a
 * time and `steps` replaces whole, so whichever of the two carries
 * `runtime.budget` decides every number in it and the other's is not applied.
 * Hence the section — the first two segments — settles *who*, and only then
 * does the leaf inside it settle file-or-default.
 */
function originIn(
  wrote: unknown,
  preset: string | null,
  path: string,
): (key: string) => string {
  return (key) => {
    const section = key.split(".").slice(0, 2).join(".");
    const carrier = carries(wrote, section)
      ? { at: path, held: wrote }
      : preset !== null && carries(PRESETS[preset], section)
        ? { at: `preset ${preset}`, held: PRESETS[preset] }
        : null;
    if (carrier === null) return "default";
    return section === key || carries(carrier.held, key) ? carrier.at : "default";
  };
}

export interface LocalRecipeOptions {
  /** `stateDir()` unless a test says otherwise. */
  home?: string;
  /** Asked only when neither the project's nor the machine's section names an agent. */
  signedIn: SignedIn;
  /**
   * The branch this project was registered against, which becomes `ref`. The
   * file has no branch of its own, so the recipe's `repo.base` stands in when
   * nothing was recorded — and `baseDivergence` still compares the two.
   */
  base?: string | null;
  /** Reads a file; null when it is not there. */
  read?: (path: string) => Promise<string | null>;
}

async function readIfThere(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * The recipe governing this project's next run, from this machine.
 *
 * Throws, like `resolveRecipe`, for the same reason: every caller's correct
 * response to an unreadable recipe is to stop.
 */
export async function resolveLocalRecipe(
  project: string,
  options: LocalRecipeOptions,
): Promise<ResolvedRecipe> {
  const home = options.home ?? stateDir();
  const read = options.read ?? readIfThere;
  const path = recipePath(project, home);
  const machineFile = machinePath(home);

  const source = await read(path);
  if (source === null) {
    throw new RecipeMissingError(
      options.base ?? path,
      `no recipe at ${path}. The recipe is yours and lives on this machine (0046 §3) — ` +
        "nothing is read from the repository, and nothing needs committing to it",
    );
  }

  const machine = parseMachineConfig(await read(machineFile), machineFile, project, home);
  const scoped = machine.projects?.[project]?.runtime;
  const shared = machine.runtime;
  const scopedAt = `${machineFile} (projects.${project})`;

  const named = scoped?.agent
    ? { agent: scoped.agent, from: scopedAt }
    : shared?.agent
      ? { agent: shared.agent, from: machineFile }
      : null;
  const agent = await resolveAgent(named, options.signedIn, machineFile);

  const provenance: Record<string, string> = {
    "runtime.agent": `${agent.agent}${PROVENANCE_ARROW}${agent.from}`,
  };

  const LIMIT_KEYS = [...(Object.keys(LIMIT_DEFAULTS) as (keyof typeof LIMIT_DEFAULTS)[]), "usd" as const];

  /** `text` as milliseconds, or null where it is not a valid duration — so a
   *  malformed one is left for the leaf refusal rather than compared here
   *  (#218, the same rule `recipe.ts`'s own narrowing check uses). */
  const wallMsOf = (text: string): number | null => (positiveDuration(text) ? parseDuration(text) : null);

  /**
   * One key of `runtime.limits`, filled into `filled` and provenanced — the
   * two-scope rule from this file's header (`#371`).
   *
   * **A malformed value in the recipe is left exactly as written.** Using it
   * for a comparison would hide the schema's own refusal of it by name; this
   * only ever compares a value whose type already matches.
   */
  function fillLimit(key: typeof LIMIT_KEYS[number], own: Record<string, unknown>, filled: Record<string, unknown>): void {
    const isWall = key === "wall";
    const rawOwn = own[key];
    const malformed = rawOwn !== undefined && (isWall ? typeof rawOwn !== "string" || !positiveDuration(rawOwn) : typeof rawOwn !== "number");
    if (malformed) return;

    const ownValue = rawOwn as number | string | undefined;
    const fallbackValue = scoped?.limits?.[key] as number | string | undefined;
    const defaultValue = key === "usd" ? undefined : LIMIT_DEFAULTS[key];
    const base = ownValue ?? fallbackValue ?? defaultValue;
    const sharedValue = shared?.limits?.[key] as number | string | undefined;

    let effective = base;
    let narrowed = false;
    if (sharedValue !== undefined) {
      if (base === undefined) {
        effective = sharedValue;
        narrowed = true;
      } else {
        const baseMs = isWall ? wallMsOf(base as string) : (base as number);
        const sharedMs = isWall ? wallMsOf(sharedValue as string) : (sharedValue as number);
        if (baseMs !== null && sharedMs !== null && sharedMs < baseMs) {
          effective = sharedValue;
          narrowed = true;
        }
      }
    }

    if (effective !== undefined) filled[key] = effective;

    const dotted = `runtime.limits.${key}`;
    if (narrowed) {
      const from = ownValue !== undefined ? "the recipe" : fallbackValue !== undefined ? scopedAt : "default";
      provenance[dotted] = `${effective}${PROVENANCE_ARROW}${machineFile} — narrowing ${from}'s ${base}`;
    } else if (ownValue !== undefined) {
      provenance[dotted] = `${effective}${PROVENANCE_ARROW}${path}`;
    } else if (fallbackValue !== undefined) {
      provenance[dotted] = `${effective}${PROVENANCE_ARROW}${scopedAt} — not yet in the recipe; the next wizard save moves it`;
    } else {
      provenance[dotted] = `${effective ?? "(none)"}${PROVENANCE_ARROW}default`;
    }

    // A stale per-project block the recipe now overrides, named rather than
    // read as live by anyone who opens `config.yml` (#371).
    if (ownValue !== undefined && fallbackValue !== undefined && fallbackValue !== ownValue) {
      provenance[`machine: projects.${project}.runtime.limits.${key}`] =
        `${fallbackValue}${PROVENANCE_ARROW}not applied: the recipe states ${ownValue}`;
    }
  }

  // What the *file itself* carries, kept before anything is merged into it.
  // This is the only place the difference survives: `recipe.source.exclude`
  // reads `[]` and `recipe.steps.proposed` reads the preset's action whether
  // this file mentions either or not, so nothing downstream can tell a value
  // this file decided from one it was silent about (#218).
  //
  // A copy, and not the object: the callback below replaces `raw.runtime` with
  // the agent filled in and the limits resolved, and the preset merges
  // underneath afterwards.
  let wrote: unknown = {};

  const resolved = resolveSource(source, options.base ?? path, path, (raw) => {
    wrote = structuredClone(raw);
    const refused: string[] = [];
    const runtime = raw["runtime"];
    const own =
      runtime !== null && typeof runtime === "object" && !Array.isArray(runtime)
        ? (runtime as Record<string, unknown>)
        : {};
    if ("agent" in own) {
      refused.push(
        `runtime.agent: moved to this machine (0046 §3) — write it in ${machineFile}, ` +
          `under \`runtime:\` or \`projects.${project}.runtime:\`. Nothing here was applied`,
      );
    }
    if (refused.length > 0) return refused;

    const ownLimitsRaw = own["limits"];
    const ownLimits =
      ownLimitsRaw === undefined
        ? ({} as Record<string, unknown>)
        : ownLimitsRaw !== null && typeof ownLimitsRaw === "object" && !Array.isArray(ownLimitsRaw)
          ? (ownLimitsRaw as Record<string, unknown>)
          : null;
    // Not a mapping at all — left exactly as written, for the schema to
    // refuse: comparing through it would hide that refusal (#371).
    if (ownLimits === null) {
      raw["runtime"] = { ...own, agent: agent.agent };
      return [];
    }

    const filled: Record<string, unknown> = {};
    for (const key of LIMIT_KEYS) fillLimit(key, ownLimits, filled);
    raw["runtime"] = { ...own, agent: agent.agent, limits: { ...ownLimits, ...filled } };
    return [];
  });

  // What stays the repository's facts, from the recipe file — said with its
  // value, so the doctor prints the resolved recipe rather than a list of names.
  const { recipe } = resolved;
  const list = (items: readonly string[]) => (items.length > 0 ? items.join(", ") : "(none)");
  const recipeValues: Record<string, string> = {
    "repo.base": baseOf(recipe),
    "source.kinds": kindsOf(recipe).join(" > "),
    "source.exclude": list(excludeOf(recipe)),
    // Said out loud by a reading, and not carried here until now — so that
    // every row of one has a source beside it (#218).
    "source.backoff": backoffOf(recipe),
    "env.required": list(recipe.env.required),
    steps: Object.entries(recipe.steps)
      .map(([step, actions]) => `${step} ${actions.length}`)
      .join(", "),
  };
  // Per field, as `runtime.limits` is: a recipe that sets `attempts` and
  // nothing else must not put this file's name against the three numbers it
  // does not contain.
  for (const [key, value] of Object.entries(recipe.runtime.budget)) {
    recipeValues[`runtime.budget.${key}`] = String(value);
  }
  // Beside `runtime.budget`: a discussion's own agent and spend, not asked of
  // the file until #243 gave `discuss:` a place to be written (0061 §6).
  recipeValues["discuss.agent"] = recipe.discuss.agent;
  recipeValues["discuss.model"] = recipe.discuss.model ?? "(none)";
  recipeValues["discuss.limits.turns"] = String(recipe.discuss.limits.turns);
  recipeValues["discuss.limits.wall"] = recipe.discuss.limits.wall;
  const from = originIn(wrote, resolved.preset, path);
  for (const [key, value] of Object.entries(recipeValues))
    provenance[key] = `${value}${PROVENANCE_ARROW}${from(key)}`;

  // `assignee` is the recipe's now (`#373`), under either spelling — read
  // only once the recipe has resolved, because which spelling it used is a
  // fact `originIn` only has an answer for afterwards. A `claim` `queue:`
  // that names it is the source for both halves, whichever one it wrote;
  // otherwise each half asks `runtime.assignee.<key>` on its own, so a file
  // that wrote only `login` still reads `take: both ← default`.
  const rule = assigneeOf(recipe);
  const atStep = recipe.steps.claim.some((action) => "queue" in action) ? from("steps.claim") : null;
  provenance["runtime.assignee.take"] = `${rule?.take ?? "both"}${PROVENANCE_ARROW}${atStep ?? from("runtime.assignee.take")}`;
  provenance["runtime.assignee.login"] = `${rule?.login ?? "(none)"}${PROVENANCE_ARROW}${atStep ?? from("runtime.assignee.login")}`;

  return { ...resolved, ref: options.base ?? baseOf(resolved.recipe), provenance };
}

/** The two files a recipe built elsewhere becomes on this machine, or why it cannot. */
export type MachineFiles =
  | {
      ok: true;
      /**
       * `recipePath(project)`'s text: the recipe without `runtime.agent`,
       * which is carried to `machine`. `runtime.limits` stays in it since
       * `#371`. `runtime.assignee` is left exactly as the recipe wrote it
       * (`#373`) — it is not one of these fields' business either.
       */
      recipe: string;
      /** `machinePath()`'s new text, or null when it already says this and needs no write. */
      machine: string | null;
    }
  | { ok: false; refusal: string };

/**
 * A whole recipe — the wizard's, with its agent in it — split into the files
 * `resolveLocalRecipe` reads (0046 §3, #180, `#371`).
 *
 * The agent the page chose is not dropped: it goes under
 * `projects.<project>.runtime.agent` in the machine file, which is where a
 * choice for one repository lives, and every other byte of that file is kept.
 * A machine file that already names a *different* runtime for this project is
 * refused rather than overwritten — both are a person's recorded choice, and
 * which one is meant is theirs to say. `runtime.assignee` takes no part in any
 * of this since `#373`: it is the recipe's, so this function neither reads it
 * out of the machine file nor writes it there.
 *
 * **It also migrates `projects.<project>.runtime.limits`, wherever it
 * sits** (`#371`): the ceiling's old home, deleted here on both callers —
 * onboarding and an edit alike — because the recipe written beside it now
 * carries the whole ceiling itself (`input.recipe.runtime.limits`, from
 * `emitRecipe` or from the file edit the caller already made). The deletion
 * runs whether or not the agent changed, so a save that touches no dial still
 * moves the stale block out from under it.
 */
export function machineFiles(input: {
  /** The recipe as emitted, comments and all. */
  file: string;
  recipe: Recipe;
  project: string;
  /** The machine file's current text, or null when there is none. */
  machine: string | null;
  home?: string;
  /**
   * Set the project's agent even when it already says something else. For an
   * edit a person made to that very section on a page showing its current
   * value — never for a first onboarding, which must not overwrite a choice.
   */
  replace?: boolean;
}): MachineFiles {
  const home = input.home ?? stateDir();
  const doc = parseDocument(input.file);
  // A file already without it — the machine's own, being edited — has no `runtime.agent` to delete.
  if (doc.hasIn(["runtime", "agent"])) doc.deleteIn(["runtime", "agent"]);
  const recipe = doc.toString({ lineWidth: 0, flowCollectionPadding: false });

  const at = ["projects", input.project, "runtime"];
  const path = machinePath(home);
  const chosenAgent = input.recipe.runtime.agent;

  if (input.machine === null || input.machine.trim() === "") {
    const created = new Document({ projects: { [input.project]: { runtime: { agent: chosenAgent } } } });
    return { ok: true, recipe, machine: created.toString() };
  }

  const machine = parseDocument(input.machine);
  if (machine.errors.length > 0 || !isMap(machine.contents)) {
    return {
      ok: false,
      refusal: `${path} does not parse as a mapping, so ${input.project}'s agent cannot be added to it — fix it and press this again`,
    };
  }

  const migrated = migrateLegacyLimits(machine, at, input.project);

  if (machine.hasIn(at)) {
    const json = toJSON(machine.getIn(at)) as { agent?: unknown } | undefined;
    if (json !== undefined && isDeepStrictEqual(json.agent, chosenAgent)) {
      return { ok: true, recipe, machine: migrated ? machine.toString() : null };
    }
    if (input.replace) {
      machine.setIn([...at, "agent"], chosenAgent);
      return { ok: true, recipe, machine: machine.toString() };
    }
    return {
      ok: false,
      refusal:
        `${path} already sets projects.${input.project}.runtime.agent to ${JSON.stringify(json?.agent)}, and this ` +
        `page chose ${JSON.stringify(chosenAgent)}. Nothing was written — edit that section, or remove it and press this again`,
    };
  }
  machine.setIn([...at, "agent"], chosenAgent);
  return { ok: true, recipe, machine: machine.toString() };
}

function toJSON(node: unknown): unknown {
  return node !== null && typeof node === "object" && "toJSON" in node ? (node as { toJSON: () => unknown }).toJSON() : node;
}

/**
 * Deletes `projects.<project>.runtime.limits` wherever it sits, and its
 * now-empty parents — the ceiling's old home (`#180`), moved into the recipe
 * by `#371`. Returns whether anything was deleted, so a caller with nothing
 * else to write still writes the migration rather than reporting `machine:
 * null`.
 */
function migrateLegacyLimits(machine: Document, at: readonly string[], project: string): boolean {
  const limitsAt = [...at, "limits"];
  if (!machine.hasIn(limitsAt)) return false;
  machine.deleteIn(limitsAt);
  const runtime = machine.getIn(at);
  if (isMap(runtime) && runtime.items.length === 0) {
    machine.deleteIn(at);
    const scope = machine.getIn(["projects", project]);
    if (isMap(scope) && scope.items.length === 0) machine.deleteIn(["projects", project]);
  }
  return true;
}

/**
 * Whether the machine file still carries this project's old ceiling —
 * `projects.<project>.runtime.limits`, the home `#180` gave it and `#371`
 * moves it out from under.
 *
 * Parsed rather than resolved: `editExisting` asks this before it knows
 * whether any dial moved, because a save that touches nothing still migrates
 * the block away.
 */
export function hasLegacyProjectLimits(machineText: string | null, project: string): boolean {
  if (machineText === null || machineText.trim() === "") return false;
  const doc = parseDocument(machineText);
  if (doc.errors.length > 0) return false;
  return doc.hasIn(["projects", project, "runtime", "limits"]);
}

/**
 * `fileAlone`'s ceiling, with a key the file leaves silent read from this
 * project's legacy per-project fallback where the machine states one —
 * `ceilingOf(fileAlone)` otherwise. **Never a machine-wide narrowing cap**:
 * that scope only ever narrows at resolve time (this file's header), so a
 * writer must not read it back as a number to persist.
 *
 * **For `editExisting`'s write path** (`#371`): the page's dials are seeded
 * from `resolveLocalRecipe`'s narrowed resolve, so a key nobody touched on
 * the page still carries that narrow. Writing it back as the recipe's own
 * stated ceiling would make the narrow permanent — a cap raised later could
 * never raise it again, because `min()` cannot give back a number the recipe
 * itself now states. `hasLegacyProjectLimits` only asks whether the legacy
 * block exists; this reads the numbers out of it.
 */
export function unnarrowedCeiling(
  fileText: string,
  fileAlone: Recipe,
  machineText: string | null,
  project: string,
): Recipe["runtime"]["limits"] {
  const doc = parseDocument(fileText);
  const machine = machineText === null ? null : parseDocument(machineText);
  const filled: Record<string, unknown> = {};
  for (const key of Object.keys(LIMIT_DEFAULTS) as (keyof typeof LIMIT_DEFAULTS)[]) {
    if (doc.errors.length === 0 && doc.hasIn(["runtime", "limits", key])) continue;
    const legacy =
      machine !== null && machine.errors.length === 0
        ? machine.getIn(["projects", project, "runtime", "limits", key])
        : undefined;
    if (legacy !== undefined) filled[key] = legacy;
  }
  return { ...ceilingOf(fileAlone), ...filled } as Recipe["runtime"]["limits"];
}
