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
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { PREFIX, machineEnvFile, stateDir } from "@lingtai/env";
import { dirname, join } from "node:path";

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
  const { file, merged, fromFile, commands } = await readEnvLayers(options);

  const deferred = required.filter((name) => commands[name] !== undefined);
  const missing = required.filter((name) => !(name in merged));

  const values = filterEnv(merged, { allow: options.allow, deny: options.deny });
  // Over every value that actually reaches an agent, from either file — which
  // is the only place it can be over, now that the filters run last.
  for (const [name, value] of Object.entries(values)) guardProduction(name, value, patterns);

  const names = layerNames(merged, fromFile, required);

  return {
    values,
    names,
    missing,
    deferred,
    file,
    refusal: refusalFor(options.project, missing, deferred, file),
  };
}

/**
 * The two files, read and merged, with nothing decided about them yet.
 *
 * Shared by `resolveAgentEnv` and by `projectEnvNames`, which is what `lingtai
 * env list` asks. Splitting it out is what stops the listing command growing a
 * second, subtly different idea of which layer answered for a name — the thing
 * the operator is being asked to be responsible for
 * ([0021](../../../doc/decisions/0021-the-recipe-decides-the-environment.md)).
 */
async function readEnvLayers(options: {
  project: string;
  machine?: Record<string, string>;
  home?: string;
}): Promise<{
  file: string;
  merged: Record<string, string>;
  fromFile: Set<string>;
  commands: Record<string, string>;
}> {
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

  return { file, merged, fromFile, commands: parsed.commands };
}

function layerNames(
  merged: Record<string, string>,
  fromFile: ReadonlySet<string>,
  also: readonly string[] = [],
): AgentEnvName[] {
  return [...new Set([...Object.keys(merged), ...also])].sort().map((name) => ({
    name,
    layer: fromFile.has(name) ? "project file" : name in merged ? "machine file" : "not set",
  }));
}

function refusalFor(
  project: string,
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
    // The command, not the path and the format. Naming the file left four
    // things to get right — the directory, the filename, dotenv syntax, and
    // `chmod 600` — for one key and one value, and the failure of each was the
    // same silent refusal this sentence is reporting (`#62`). `set` with no
    // value reads stdin unechoed, which is how a connection string stays out
    // of shell history.
    lines.push(
      `  ${ordinary.join(", ")}: lingtai env set ${project} ${ordinary[0]}` +
        `${ordinary.length > 1 ? " (one per name)" : ""} — it reads the value from stdin, unechoed.`,
    );
  }
  const asked = missing.filter((n) => isDeferredName.has(n));
  if (asked.length > 0) {
    lines.push(
      `  ${asked.join(", ")}: ${file} asks for a secret source (a "!" value), which is not built yet. ` +
        `Write the value with lingtai env set ${project} ${asked[0]}, or quote it to mean it literally.`,
    );
  }
  return lines.join("\n");
}

// ----------------------------------------------- writing the project's file ---

/**
 * The mode the project's file is **created** with.
 *
 * Not enforced on a file that already exists: that mode is the operator's, and
 * a command that reset it would be a command that widened a file somebody had
 * deliberately narrowed, while claiming to be securing it.
 */
export const ENV_FILE_MODE = 0o600;
/** `~/.lingtai/env`, created with the same instinct as the file inside it. */
export const ENV_DIR_MODE = 0o700;

/**
 * A `!` value refused, with the thing to do instead.
 *
 * Layer 4 does not exist, so `SECRET=!op read op://…` written today is eight
 * characters and a shell command sitting where a connection string belongs —
 * and the project goes on refusing, past a line that reads as correct. The one
 * value that really does start with `!` still has an escape hatch, and it is
 * the one `parseEnvFile` documents: quote it, by hand, in the file.
 */
export class SecretSourceError extends Error {
  override readonly name = "SecretSourceError";
  readonly variable: string;

  constructor(variable: string) {
    super(
      `${variable}: a value beginning with "!" is reserved for a secret source — layer 4 of ` +
        "0021, which is not built. Writing it would plant the literal text where the value " +
        "belongs, and the project would go on refusing past a line that looks correct. " +
        `If "!" really is the first character of the value, write the line by hand and quote ` +
        `it: ${variable}="!…" is those characters and nothing else.`,
    );
    this.variable = variable;
  }
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A project name is a filename here, so `..` and a slash have to be refused. */
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function checkName(name: string): string {
  if (!ENV_NAME.test(name)) {
    throw new Error(`"${name}" is not an environment variable name — letters, digits and _, not starting with a digit`);
  }
  return name;
}

function checkProject(project: string): string {
  if (!PROJECT_NAME.test(project)) {
    throw new Error(`"${project}" is not a project name — it is used as a filename under ~/.lingtai/env`);
  }
  return project;
}

/**
 * The name a `.env` line declares, or null for a blank line or a comment.
 *
 * The same reading `parseEnvFile` does, so that a line this recognises is a
 * line that would have answered for the name — which is what makes replacing
 * exactly one of them correct.
 */
function nameOfLine(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return null;
  const eq = trimmed.indexOf("=");
  if (eq <= 0) return null;
  const name = trimmed.slice(0, eq).trim().replace(/^export\s+/, "");
  return name === "" ? null : name;
}

function linesOf(text: string): string[] {
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return body === "" ? [] : body.split("\n");
}

/**
 * One line replaced or appended, and **every other line left exactly as it was**.
 *
 * Not a parse and a re-render: that would lose the comments the operator wrote
 * beside the values, and a file that silently reformats itself is one people
 * stop editing by hand. The value is JSON-quoted, which is `parseEnvFile`'s
 * inverse — so a password holding a `$`, a `#`, a space or a newline round
 * trips as itself, with nothing expanding and nothing truncating it.
 *
 * A duplicate line for the same name is dropped rather than kept: the last one
 * wins on the way back in, so leaving it would mean `set` wrote a value the
 * file does not report.
 */
export function setEnvLine(text: string, name: string, value: string): string {
  const line = `${name}=${JSON.stringify(value)}`;
  const out: string[] = [];
  let written = false;
  for (const l of linesOf(text)) {
    if (nameOfLine(l) !== name) {
      out.push(l);
      continue;
    }
    if (written) continue;
    out.push(line);
    written = true;
  }
  if (!written) out.push(line);
  return `${out.join("\n")}\n`;
}

/** Every line declaring the name removed, comments and neighbours untouched. */
export function unsetEnvLine(text: string, name: string): { text: string; removed: boolean } {
  const lines = linesOf(text);
  const kept = lines.filter((l) => nameOfLine(l) !== name);
  return {
    text: kept.length === 0 ? "" : `${kept.join("\n")}\n`,
    removed: kept.length !== lines.length,
  };
}

function header(project: string): string {
  return (
    `# ${project} — the values Lingtai merges over the machine's own file when it\n` +
    `# prepares a run (doc/decisions/0021). One NAME=value per line.\n` +
    `# Written by \`lingtai env set ${project}\`; edit it by hand if you prefer.\n`
  );
}

async function readOrNull(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * `lingtai env set` — one name, one value, in the file the project reads.
 *
 * Creates the directory and the file, replaces one line, and leaves the file
 * `0600`. It does **not** chmod a file that already exists: the mode is the
 * operator's if they have narrowed it, and a command that widened a file while
 * claiming to secure it would be worse than one that never touched it.
 *
 * A `!` value is refused rather than written — see `SecretSourceError`.
 */
export async function setProjectEnv(options: {
  project: string;
  name: string;
  value: string;
  home?: string;
}): Promise<{ file: string; created: boolean; replaced: boolean }> {
  const project = checkProject(options.project);
  const name = checkName(options.name);
  if (options.value.startsWith("!")) throw new SecretSourceError(name);

  const file = projectEnvPath(project, options.home ?? stateDir());
  const before = await readOrNull(file);
  const created = before === null;
  const text = before ?? header(project);
  const replaced = linesOf(text).some((l) => nameOfLine(l) === name);

  await mkdir(dirname(file), { recursive: true, mode: ENV_DIR_MODE });
  await writeFile(file, setEnvLine(text, name, options.value), { mode: ENV_FILE_MODE });
  // `mode` on `writeFile` only applies when the file is created, and a umask
  // can narrow it on the way. Asked for outright, so "the file is 0600" is a
  // fact rather than a hope.
  if (created) await chmod(file, ENV_FILE_MODE);

  return { file, created, replaced };
}

/** `lingtai env unset` — the name gone from the file, and nothing else changed. */
export async function unsetProjectEnv(options: {
  project: string;
  name: string;
  home?: string;
}): Promise<{ file: string; removed: boolean }> {
  const project = checkProject(options.project);
  const name = checkName(options.name);
  const file = projectEnvPath(project, options.home ?? stateDir());

  const before = await readOrNull(file);
  if (before === null) return { file, removed: false };
  const { text, removed } = unsetEnvLine(before, name);
  if (removed) await writeFile(file, text, { mode: ENV_FILE_MODE });
  return { file, removed };
}

export interface ProjectEnvListing {
  file: string;
  /** Every name either file offers, and which one answered. Never a value. */
  names: AgentEnvName[];
  /** Names in the project's file whose value asks for the unbuilt layer 4. */
  deferred: string[];
}

/**
 * `lingtai env list` — what is set for a project, and where it came from.
 *
 * The recipe is not consulted, deliberately: this answers "what does this
 * machine hold for this project", which is a question worth being able to ask
 * with no App configured and no recipe fetched. What a *run* would then do with
 * it — `required`, `allow`, `deny` — is `lingtai doctor`'s answer, from
 * `resolveAgentEnv`, over these same two layers.
 */
export async function projectEnvNames(options: {
  project: string;
  machine?: Record<string, string>;
  home?: string;
}): Promise<ProjectEnvListing> {
  const project = checkProject(options.project);
  const { file, merged, fromFile, commands } = await readEnvLayers({ ...options, project });
  const deferred = Object.keys(commands).sort();
  return { file, names: layerNames(merged, fromFile, deferred), deferred };
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
