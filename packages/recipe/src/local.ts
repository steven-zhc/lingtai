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
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { RuntimeId } from "@lingtai/domain";
import { stateDir } from "@lingtai/env";
import { LIMIT_DEFAULTS } from "./recipe.ts";
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
    "runtime.agent": `${agent.agent} ← ${agent.from}`,
  };
  const limits: Record<string, unknown> = {};
  for (const key of Object.keys(LIMIT_DEFAULTS) as (keyof typeof LIMIT_DEFAULTS)[]) {
    const value = scoped?.limits?.[key] ?? shared?.limits?.[key];
    const from =
      scoped?.limits?.[key] !== undefined ? scopedAt : shared?.limits?.[key] !== undefined ? machineFile : "default";
    limits[key] = value ?? LIMIT_DEFAULTS[key];
    provenance[`runtime.limits.${key}`] = `${limits[key]} ← ${from}`;
  }

  const resolved = resolveSource(source, options.base ?? path, path, (raw) => {
    const refused: string[] = [];
    const runtime = raw["runtime"];
    const own =
      runtime !== null && typeof runtime === "object" && !Array.isArray(runtime)
        ? (runtime as Record<string, unknown>)
        : {};
    for (const key of ["agent", "limits"]) {
      if (key in own) {
        refused.push(
          `runtime.${key}: moved to this machine (0046 §3) — write it in ${machineFile}, ` +
            `under \`runtime:\` or \`projects.${project}.runtime:\`. Nothing here was applied`,
        );
      }
    }
    if (refused.length > 0) return refused;
    raw["runtime"] = { ...own, agent: agent.agent, limits };
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
    "env.required": list(recipe.env.required),
    gates: Object.entries(recipe.gates)
      .map(([point, actions]) => `${point} ${actions.length}`)
      .join(", "),
  };
  for (const [key, value] of Object.entries(recipeValues)) provenance[key] = `${value} ← ${path}`;
  return { ...resolved, ref: options.base ?? resolved.recipe.repo.base, provenance };
}
