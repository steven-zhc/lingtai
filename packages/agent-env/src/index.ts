/**
 * The environment an agent is given, in named layers.
 *
 * **Filtered, not inherited.** The agent gets exactly the variable names the
 * recipe *requires*, merged from layers with different owners, and a name with
 * no value in any of them refuses the project rather than being logged. This is
 * one of the three real boundaries
 * ([0007](../../../doc/decisions/0007-dual-runtime.md), reshaped by
 * [0021](../../../doc/decisions/0021-the-recipe-decides-the-environment.md));
 * the hook is not one.
 *
 * Its own package since [0022](../../../doc/decisions/0022-the-seams.md), and
 * the reason is the one thing it must never be confused with: `@lingtai/env`
 * holds **the machine's** credentials, which the agent must never see. This
 * holds **the agent's**. They were adjacent in one file, which is exactly how a
 * database URL ends up in a subprocess.
 *
 * All of it is a decision — names and values in, a filtered set out — bar
 * `resolveAgentEnv`, which reads the project's own file. That one read is the
 * whole of the impurity and is marked where it happens.
 */
import { readFile } from "node:fs/promises";
import { PREFIX, machineEnvFile, stateDir } from "@lingtai/env";
import { join } from "node:path";

// ------------------------------------------------------------ environment ----

export class ProductionValueError extends Error {
  override readonly name = "ProductionValueError";
  readonly variable: string;
  readonly matched: string;

  constructor(variable: string, matched: string) {
    super(
      `${variable} looks like production (its host matches "${matched}"). ` +
        "Refusing to plant it: an agent must never hold a production credential.",
    );
    this.variable = variable;
    this.matched = matched;
  }
}

/**
 * Host substrings that mean "do not give this to an agent".
 *
 * **Not yet configurable, and it should be.** ADR 0005 puts production host
 * patterns in configuration, but no field carries them yet, so these are a
 * built-in default a caller can override. Adding that field is a change to the
 * recipe schema, not to this list.
 *
 * Matched against the *host* of a URL-shaped value, by segment. Matching the
 * whole string trips on a password containing "prod"; matching the host by
 * substring trips on `reproducible.dev.example.com`. Either way a tripwire that
 * cries wolf trains people to pass an override flag, which is the worst outcome
 * for one. See `hostLooksProduction`.
 */
export const DEFAULT_PRODUCTION_PATTERNS = ["prod", "production"];

/**
 * Whether a host is a production one, by **segment** rather than by substring.
 *
 * Substring matching looked right and was not: `reproducible.dev.example.com`
 * contains "prod", and a tripwire that refuses a development host trains people
 * to turn it off. The host is split on `.` and `-` and a segment has to match
 * outright — `db.prod.example.com` and `prod-db.example.com` both do,
 * `reproducible.dev.example.com` does not.
 *
 * Lived in `guard.ts` and moved here when the guard was deleted (ADR 0016 §6).
 * It was never the guard's: the filtered environment is one of the three real
 * boundaries, and this is what makes it refuse rather than warn.
 */
export function hostLooksProduction(host: string, patterns: readonly string[]): string | null {
  const segments = host.toLowerCase().split(/[.\-]/);
  for (const pattern of patterns) {
    if (segments.includes(pattern.toLowerCase())) return pattern;
  }
  return null;
}

/**
 * The one name-shaped rule left, and it is a prefix rather than a list.
 *
 * `#63` made every name Lingtai reads for itself begin `LINGTAI_`, and that is
 * what lets this be one rule instead of the `RESERVED` denylist 0021 deleted:
 * there is nothing to keep up to date and nothing to forget.
 *
 * **It applies to the machine's file only.** `.env.local` holds this system's
 * own log and the key that signs its tokens; a managed repository must never
 * receive those, whatever its recipe says. The *project's* file is written by
 * the operator for one project, so a `LINGTAI_TEST_DATABASE_URL` there is the
 * operator handing Lingtai's own test database to Lingtai's own run — which is
 * how this repository is self-hosted, and is the asymmetry that keeps working.
 */
function isMachineOwn(name: string): boolean {
  return name.startsWith(PREFIX);
}

/**
 * The variables a process needs in order to be a process at all — **layer 1**.
 *
 * `filterEnv` is an allowlist of the *project's* variables — the secrets and
 * connection strings a recipe names. It is not, and should not become, a list of
 * the things a shell needs to find a binary. Those are two different questions
 * and conflating them is how the first real run against a repository died on
 * `/bin/sh: pnpm: command not found`.
 *
 * That failure had three instances and one cause: the agent was given `PATH` and
 * `HOME`, the gates were given `PATH` and not `HOME` — which `pnpm` needs for
 * its store and its config — and the prepare stage was given neither. Three call
 * sites, three different answers, one of them right. So it is computed here,
 * once.
 *
 * Deliberately short. `NODE_OPTIONS` is excluded because it injects behaviour
 * into every child; anything a project genuinely needs belongs in `env.required`,
 * where a person wrote it down.
 *
 * `HOME` is the operator's, which is what makes a warm package store possible
 * and every install after the first one fast. It also means a command can read
 * the operator's home directory — contained by the tier, not by this, and worth
 * revisiting if a scratch home ever becomes affordable.
 *
 * **`USER` is here because Claude Code cannot log in without it.** The first
 * real run against `nextloom-ai-admin` reached the agent and died on
 * "Not logged in · Please run /login", with `HOME` set and the credentials
 * exactly where they always are. Measured directly: with `USER`, the run calls
 * the API and costs money; with `SHELL` instead and no `USER`, it reports zero
 * tokens and zero cost and never calls anything. macOS finds a keychain item by
 * who is asking, and with nobody asking there is nothing to find.
 *
 * `LOGNAME` is its POSIX twin and some tools read that one instead. `SHELL` is
 * deliberately *not* here: it was not needed, and leaving it out keeps the
 * shell a command runs under predictable rather than inherited.
 */
export const RUNNABLE = ["PATH", "HOME", "TMPDIR", "LANG", "USER", "LOGNAME"] as const;

export function runnableEnv(
  values: Record<string, string>,
  from: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const base: Record<string, string> = {};
  for (const name of RUNNABLE) {
    const value = from[name];
    if (value) base[name] = value;
  }
  // The project's own values win: a recipe that requires `PATH` meant it.
  return { ...base, ...values };
}

/**
 * The recipe's filter over data that already exists.
 *
 * It stopped being a lookup into `process.env` in `#60` and became what its
 * name says. The table is 0021's:
 *
 * | `allow` | `deny` | what passes |
 * |---|---|---|
 * | — | — | everything the two files hold |
 * | set | — | only what `allow` names |
 * | — | set | everything except `deny` |
 * | set | set | `allow` minus `deny` |
 *
 * Absent and empty differ: no `allow` means no allowlist, `allow: []` means
 * nothing passes. That is why the parameter is optional rather than defaulted.
 */
export function filterEnv(
  merged: Record<string, string>,
  filters: { allow?: readonly string[] | undefined; deny?: readonly string[] | undefined } = {},
): Record<string, string> {
  const allow = filters.allow ? new Set(filters.allow) : null;
  const deny = new Set(filters.deny ?? []);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(merged)) {
    if (allow && !allow.has(name)) continue;
    if (deny.has(name)) continue;
    out[name] = value;
  }
  return out;
}

function guardProduction(name: string, value: string, patterns: readonly string[]): void {
  const host = hostOf(value);
  if (!host) return;
  const hit = hostLooksProduction(host, patterns);
  if (hit) throw new ProductionValueError(name, hit);
}

/** The host of a URL-shaped value, or null when it is not one. */
function hostOf(value: string): string | null {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return null;
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

// ------------------------------------------------------ the project's file ---

/** **Layer 3**: `~/.lingtai/env/<project>.env`, and the only file layer there is. */
export function projectEnvPath(project: string, home: string = stateDir()): string {
  return join(home, "env", `${project}.env`);
}

export interface EnvFile {
  values: Record<string, string>;
  /**
   * Names whose value asks for a **secret source** — layer 4, which is not
   * built. Kept apart rather than taken literally: planting `!op read op://…`
   * as a connection string is the silent half-move this file exists to refuse.
   */
  commands: Record<string, string>;
}

/**
 * `.env`-file text → names and values, with room reserved for a secret source.
 *
 * The format is the ordinary one, with one rule added now so that layer 4 can
 * be added later without changing any file anybody has written: **an unquoted
 * value beginning with `!` is a command, not a value.** Quoting is therefore the
 * escape hatch — `TOKEN="!literal"` is those eight characters, `TOKEN=!op read …`
 * is a request Lingtai cannot yet satisfy and says so.
 *
 * A double-quoted value is JSON, which makes this the exact inverse of
 * `renderEnvFile` and means an embedded newline survives a round trip.
 */
export function parseEnvFile(text: string): EnvFile {
  const values: Record<string, string> = {};
  const commands: Record<string, string> = {};

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim().replace(/^export\s+/, "");
    const raw = trimmed.slice(eq + 1).trim();
    if (name === "") continue;

    if (raw.startsWith("!")) {
      commands[name] = raw.slice(1).trim();
      continue;
    }
    if (raw.startsWith('"')) {
      try {
        values[name] = JSON.parse(raw) as string;
        continue;
      } catch {
        // Not JSON after all. Fall through and take it literally rather than
        // dropping the line — a value nobody can see is worse than a quoted one.
      }
    }
    if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
      values[name] = raw.slice(1, -1);
      continue;
    }
    values[name] = raw;
  }

  return { values, commands };
}

// --------------------------------------------------- the merged environment ---

/** Where a declared name's value came from. Names only — never values. */
export type EnvLayer = "machine file" | "project file" | "not set";

export interface AgentEnvName {
  name: string;
  layer: EnvLayer;
}

export interface AgentEnv {
  /** What reaches the agent, after `allow`/`deny`. Layer 1 is added by `runnableEnv`. */
  values: Record<string, string>;
  /** Every name either file offered, and which one answered, in name order. */
  names: AgentEnvName[];
  /** `required` names the merged data did not supply. */
  missing: string[];
  /** Declared names whose file value asks for the unbuilt layer 4. */
  deferred: string[];
  /** The per-project file, whether or not it exists. */
  file: string;
  /**
   * Why this project cannot run, or null.
   *
   * One string rather than lists to inspect: every caller's correct response is
   * the same — refuse the project before anything is claimed — and a caller that
   * assembled the sentence itself would assemble a different one each time.
   */
  refusal: string | null;
}

/**
 * The environment an agent may see, and the refusal when it cannot be completed.
 *
 * **Merge first, filter second** (`#60`). The two files are merged — the
 * project's over the machine's — `required` is checked against *that*, and only
 * then do `allow` and `deny` decide what actually reaches the agent. The order
 * is what makes a name that is both required and denied legal: the machine must
 * have it, and this run does not see it
 * ([0021](../../../doc/decisions/0021-the-recipe-decides-the-environment.md)).
 *
 * The machine's **file**, not `process.env`: the operator's shell carries
 * `AWS_*`, npm tokens and whatever else is exported in the terminal a command
 * was typed into, and none of that is something either file offered.
 *
 * Runs nothing and claims nothing — it is a function of the recipe, two files
 * and a clock, which is what lets `lingtai doctor` ask it for free.
 */
export async function resolveAgentEnv(options: {
  project: string;
  /** `env.required` — checked against the merged data, before the filters. */
  required?: readonly string[];
  /** `env.allow` — absent means no allowlist; `[]` means nothing passes. */
  allow?: readonly string[] | undefined;
  /** `env.deny` — names that never reach the agent. */
  deny?: readonly string[] | undefined;
  /** Layer 2, injectable. Defaults to the machine's own env file. */
  machine?: Record<string, string>;
  home?: string;
  patterns?: readonly string[];
}): Promise<AgentEnv> {
  const required = options.required ?? [];
  const patterns = options.patterns ?? DEFAULT_PRODUCTION_PATTERNS;
  const file = projectEnvPath(options.project, options.home ?? stateDir());

  // Layer 2, minus what is Lingtai's own. See `isMachineOwn`: this is the one
  // asymmetry left, and it is a prefix rather than a list.
  const fromMachine: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.machine ?? machineEnvFile())) {
    if (!isMachineOwn(name) && value !== "") fromMachine[name] = value;
  }

  let parsed: EnvFile = { values: {}, commands: {} };
  try {
    parsed = parseEnvFile(await readFile(file, "utf8"));
  } catch {
    // No file is the ordinary case for a project whose values are all on the
    // machine. An unreadable one is reported by the names it fails to supply.
  }

  // Layer 3 over layer 2: one project can differ from the machine.
  const merged: Record<string, string> = { ...fromMachine };
  const fromFile = new Set<string>();
  for (const [name, value] of Object.entries(parsed.values)) {
    if (value === "") continue;
    merged[name] = value;
    fromFile.add(name);
  }

  const deferred = required.filter((name) => parsed.commands[name] !== undefined);
  const missing = required.filter((name) => !(name in merged));

  const values = filterEnv(merged, { allow: options.allow, deny: options.deny });
  // Over every value that actually reaches an agent, from either file — which
  // is the only place it can be over, now that the filters run last.
  for (const [name, value] of Object.entries(values)) guardProduction(name, value, patterns);

  const names: AgentEnvName[] = [...new Set([...Object.keys(merged), ...required])]
    .sort()
    .map((name) => ({
      name,
      layer: fromFile.has(name) ? "project file" : name in merged ? "machine file" : "not set",
    }));

  return { values, names, missing, deferred, file, refusal: refusalFor(missing, deferred, file) };
}

function refusalFor(
  missing: readonly string[],
  deferred: readonly string[],
  file: string,
): string | null {
  if (missing.length === 0) return null;
  const isDeferredName = new Set(deferred);

  const lines = [
    `env: ${missing.join(", ")} declared in env.required and not set in either file. ` +
      `Nothing was claimed and no agent was started.`,
  ];

  const ordinary = missing.filter((n) => !isDeferredName.has(n));
  if (ordinary.length > 0) {
    lines.push(`  ${ordinary.join(", ")}: write ${file} — one NAME=value per line.`);
  }
  const asked = missing.filter((n) => isDeferredName.has(n));
  if (asked.length > 0) {
    lines.push(
      `  ${asked.join(", ")}: ${file} asks for a secret source (a "!" value), which is not built yet. ` +
        `Write the value, or quote it to mean it literally.`,
    );
  }
  return lines.join("\n");
}

/** `.env`-file text. Values are quoted so a `#` or a space cannot truncate one. */
export function renderEnvFile(values: Record<string, string>): string {
  const lines = [
    "# Written by Lingtai for one run. Not committed, not inherited —",
    "# only the names the recipe's env.required lists.",
  ];
  for (const [name, value] of Object.entries(values).sort(([a], [b]) => (a < b ? -1 : 1))) {
    lines.push(`${name}=${JSON.stringify(value)}`);
  }
  return `${lines.join("\n")}\n`;
}
