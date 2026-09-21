/**
 * The recipe is mine: `~/.lingtai/<project>/recipe.yml`, and the machine's own
 * half beside it in `~/.lingtai/config.yml`
 * ([0046](../../../doc/decisions/0046-lingtai-is-personal.md) §3).
 *
 * **The repository holds facts about itself; everything else is mine.** So the
 * recipe keeps `repo`, `source`, `env`, `gates` and `subscribers` — what this
 * repository needs and how I want its work judged — and the two fields that
 * were facts about a machine sitting in a file about a project move out of it:
 *
 * - `runtime.agent`, because which CLI is installed and signed in is a fact
 *   about this machine. **It moves; it does not go** — 0007 supports two
 *   runtimes, both can be signed in at once, and a choice nobody wrote down is
 *   the default this is here to refuse.
 * - `runtime.limits`, because more rounds does not lower quality — the gates
 *   decide that. It costs more money, and that is the spender's call.
 *
 * Nothing here makes a request. The file is read on every resolve, as the
 * branch was, so an edit reaches the next run and a daemon holds nothing stale.
 *
 * **Both files refuse what belongs in the other, by name.** A key silently
 * dropped and a key that does not exist are different facts to whoever wrote
 * it (0016 §4), and `gates` in the machine file is the one that matters: a gate
 * that reads as declared and holds nothing is a way to weaken a gate quietly.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Document, isMap, parse as parseYaml, parseDocument } from "yaml";
import { z } from "zod";
import { RuntimeId } from "@lingtai/domain";
import { stateDir } from "@lingtai/env";
import { PRESETS } from "./presets.ts";
import { AssigneeRule, AssigneeTake, LIMIT_DEFAULTS, type Recipe } from "./recipe.ts";
import { RecipeMissingError, type ResolvedRecipe, resolveSource } from "./resolve.ts";

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
  wall: z.string().optional(),
  rounds: z.number().int().nonnegative().optional(),
  restarts: z.number().int().nonnegative().optional(),
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
  /**
   * Whose tickets this machine takes (0046 §2, #181). Both keys optional, so
   * the login can be said once machine-wide and `take` per project.
   */
  assignee: z
    .strictObject({ login: z.string().min(1).optional(), take: AssigneeTake.optional() })
    .optional(),
});

/**
 * `~/.lingtai/config.yml`.
 *
 * Not strict at the top: this file is the machine's (ports, a database URL —
 * doc/design/1.0.md), and a section some other reader owns is not this
 * reader's to refuse. `gates` is refused anyway, before the schema, because it
 * is the one key whose silent absence weakens something.
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

function gatesRefusal(at: string, project: string, home: string): string {
  return (
    `${at}: gates do not live in the machine file — they live in the recipe, ` +
    `${recipePath(project, home)}, under \`gates:\`. Nothing here was applied; ` +
    "move the block there if it is meant to run"
  );
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
  if ("gates" in top) problems.push(gatesRefusal("gates", project, home));
  const projects = top["projects"];
  if (projects !== null && typeof projects === "object" && !Array.isArray(projects)) {
    for (const [name, scope] of Object.entries(projects as Record<string, unknown>)) {
      if (scope !== null && typeof scope === "object" && "gates" in scope) {
        problems.push(gatesRefusal(`projects.${name}.gates`, name, home));
      }
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

/** Whether an object carries a dotted path at all — not what it says there. */
function carries(value: unknown, path: string): boolean {
  let at = value;
  for (const segment of path.split(".")) {
    if (at === null || typeof at !== "object" || Array.isArray(at)) return false;
    if (!(segment in (at as Record<string, unknown>))) return false;
    at = (at as Record<string, unknown>)[segment];
  }
  return at !== undefined;
}

/**
 * Where a value in the resolved recipe came from: the file, the preset
 * underneath it, or the schema (#218).
 *
 * **Three origins and not two.** Every key here but `repo.base`, `source.kinds`
 * and `env.plantAt` has a schema default, and `gates` — the most consequential
 * of them, since it is what holds a run — can also come from a preset. A
 * resolved recipe reads the same in all three cases, so a reader told
 * `recipe.yml` for a `gates:` block that file does not contain opens it, finds
 * nothing, and cannot learn the answer anywhere: `extends: pnpm-workspace` is
 * a line about gates that never names them.
 *
 * **Asked at the level the merge happens at**, which is `applyPreset`'s rule
 * and not this function's invention: `repo` and `runtime` merge a key at a
 * time and `gates` replaces whole, so whichever of the two carries
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
  const limits: Record<string, unknown> = {};
  for (const key of Object.keys(LIMIT_DEFAULTS) as (keyof typeof LIMIT_DEFAULTS)[]) {
    const value = scoped?.limits?.[key] ?? shared?.limits?.[key];
    const from =
      scoped?.limits?.[key] !== undefined ? scopedAt : shared?.limits?.[key] !== undefined ? machineFile : "default";
    limits[key] = value ?? LIMIT_DEFAULTS[key];
    provenance[`runtime.limits.${key}`] = `${limits[key]}${PROVENANCE_ARROW}${from}`;
  }

  // Absent unless the machine said something, so a machine that has not heard
  // of assignees resolves the recipe — and its hash — exactly as before.
  const assigneeFrom = (key: "login" | "take") =>
    scoped?.assignee?.[key] !== undefined ? scopedAt : shared?.assignee?.[key] !== undefined ? machineFile : null;
  const login = scoped?.assignee?.login ?? shared?.assignee?.login;
  const take = scoped?.assignee?.take ?? shared?.assignee?.take;
  let assignee: AssigneeRule | undefined;
  if (login !== undefined || take !== undefined) {
    const parsed = AssigneeRule.safeParse({ login, take });
    if (!parsed.success) {
      throw new MachineConfigInvalidError(
        machineFile,
        parsed.error.issues.map((i) => `runtime.assignee.${i.path.join(".")}: ${i.message}`),
      );
    }
    assignee = parsed.data;
  }
  provenance["runtime.assignee.take"] = `${assignee?.take ?? "both"}${PROVENANCE_ARROW}${assigneeFrom("take") ?? "default"}`;
  provenance["runtime.assignee.login"] = `${assignee?.login ?? "(none)"}${PROVENANCE_ARROW}${assigneeFrom("login") ?? "default"}`;

  // What the *file itself* carries, kept before anything is merged into it.
  // This is the only place the difference survives: `recipe.source.exclude`
  // reads `[]` and `recipe.gates.proposed` reads the preset's action whether
  // this file mentions either or not, so nothing downstream can tell a value
  // this file decided from one it was silent about (#218).
  //
  // A copy, and not the object: the callback below replaces `raw.runtime` with
  // the machine's half, and the preset merges underneath afterwards.
  let wrote: unknown = {};

  const resolved = resolveSource(source, options.base ?? path, path, (raw) => {
    wrote = structuredClone(raw);
    const refused: string[] = [];
    const runtime = raw["runtime"];
    const own =
      runtime !== null && typeof runtime === "object" && !Array.isArray(runtime)
        ? (runtime as Record<string, unknown>)
        : {};
    for (const key of ["agent", "limits", "assignee"]) {
      if (key in own) {
        refused.push(
          `runtime.${key}: moved to this machine (0046 §3) — write it in ${machineFile}, ` +
            `under \`runtime:\` or \`projects.${project}.runtime:\`. Nothing here was applied`,
        );
      }
    }
    if (refused.length > 0) return refused;
    raw["runtime"] = { ...own, agent: agent.agent, limits, ...(assignee ? { assignee } : {}) };
    return [];
  });

  // What stays the repository's facts, from the recipe file — said with its
  // value, so the doctor prints the resolved recipe rather than a list of names.
  const { recipe } = resolved;
  const list = (items: readonly string[]) => (items.length > 0 ? items.join(", ") : "(none)");
  const recipeValues: Record<string, string> = {
    "repo.base": recipe.repo.base,
    "source.kinds": recipe.source.kinds.join(" > "),
    "source.exclude": list(recipe.source.exclude),
    // Said out loud by a reading, and not carried here until now — so that
    // every row of one has a source beside it (#218).
    "source.backoff": recipe.source.backoff,
    "env.required": list(recipe.env.required),
    gates: Object.entries(recipe.gates)
      .map(([point, actions]) => `${point} ${actions.length}`)
      .join(", "),
  };
  // Per field, as `runtime.limits` is: a recipe that sets `attempts` and
  // nothing else must not put this file's name against the three numbers it
  // does not contain.
  for (const [key, value] of Object.entries(recipe.runtime.budget)) {
    recipeValues[`runtime.budget.${key}`] = String(value);
  }
  const from = originIn(wrote, resolved.preset, path);
  for (const [key, value] of Object.entries(recipeValues))
    provenance[key] = `${value}${PROVENANCE_ARROW}${from(key)}`;
  return { ...resolved, ref: options.base ?? resolved.recipe.repo.base, provenance };
}

/** The two files a recipe built elsewhere becomes on this machine, or why it cannot. */
export type MachineFiles =
  | {
      ok: true;
      /**
       * `recipePath(project)`'s text: the recipe without `runtime.agent`,
       * `runtime.limits` and `runtime.assignee`, each of which is carried to `machine`.
       */
      recipe: string;
      /** `machinePath()`'s new text, or null when it already says this and needs no write. */
      machine: string | null;
    }
  | { ok: false; refusal: string };

/**
 * A whole recipe — the wizard's, with its agent and limits in it — split into
 * the files `resolveLocalRecipe` reads (0046 §3, #180).
 *
 * The agent and the limits the page chose are not dropped: they go under
 * `projects.<project>.runtime` in the machine file, which is where a choice for
 * one repository lives, and every other byte of that file is kept. So is the
 * project's `runtime.assignee` (#181), which the page does not show: an edit to
 * the agent or the limits replaces the section without dropping whose tickets
 * this machine takes. One written in the recipe text goes there too. A machine
 * file that already names a *different* runtime for this project is refused
 * rather than overwritten — both are a person's recorded choice, and which one
 * is meant is theirs to say.
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
   * Set the project's section even when it already says something else. For
   * an edit a person made to that very section on a page showing its current
   * value — never for a first onboarding, which must not overwrite a choice.
   */
  replace?: boolean;
}): MachineFiles {
  const home = input.home ?? stateDir();
  const doc = parseDocument(input.file);
  const toJSON = (node: unknown) =>
    node !== null && typeof node === "object" && "toJSON" in node ? (node as { toJSON: () => unknown }).toJSON() : node;
  const written = doc.hasIn(["runtime", "assignee"]) ? toJSON(doc.getIn(["runtime", "assignee"])) : undefined;
  // A file already without them — the machine's own, being edited — has no `runtime` to delete from.
  if (doc.hasIn(["runtime", "agent"])) doc.deleteIn(["runtime", "agent"]);
  if (doc.hasIn(["runtime", "limits"])) doc.deleteIn(["runtime", "limits"]);
  if (doc.hasIn(["runtime", "assignee"])) doc.deleteIn(["runtime", "assignee"]);
  const recipe = doc.toString({ lineWidth: 0, flowCollectionPadding: false });

  const at = ["projects", input.project, "runtime"];
  const path = machinePath(home);
  const choose = (kept: unknown) => ({
    agent: input.recipe.runtime.agent,
    limits: { ...input.recipe.runtime.limits },
    ...(written !== undefined ? { assignee: written } : kept !== undefined ? { assignee: kept } : {}),
  });

  if (input.machine === null || input.machine.trim() === "") {
    const created = new Document({ projects: { [input.project]: { runtime: choose(undefined) } } });
    return { ok: true, recipe, machine: created.toString() };
  }

  const machine = parseDocument(input.machine);
  if (machine.errors.length > 0 || !isMap(machine.contents)) {
    return {
      ok: false,
      refusal: `${path} does not parse as a mapping, so ${input.project}'s agent and limits cannot be added to it — fix it and press this again`,
    };
  }
  // Not the resolved recipe's assignee: its login may be the machine-wide one,
  // and copying it into this project's section would stop it following that.
  const kept = machine.hasIn([...at, "assignee"]) ? toJSON(machine.getIn([...at, "assignee"])) : undefined;
  const chosen = choose(kept);
  if (machine.hasIn(at)) {
    const json = toJSON(machine.getIn(at));
    if (isDeepStrictEqual(json, chosen)) return { ok: true, recipe, machine: null };
    if (input.replace) {
      machine.setIn(at, chosen);
      return { ok: true, recipe, machine: machine.toString() };
    }
    return {
      ok: false,
      refusal:
        `${path} already sets projects.${input.project}.runtime to ${JSON.stringify(json)}, and this page chose ` +
        `${JSON.stringify(chosen)}. Nothing was written — edit that section, or remove it and press this again`,
    };
  }
  machine.setIn(at, chosen);
  return { ok: true, recipe, machine: machine.toString() };
}
