/**
 * A recipe proposed by reading a repository — the onboarding wizard's fast lane
 * ([doc/design/the-onboarding-wizard.md](../../../doc/design/the-onboarding-wizard.md),
 * *Fast*; #161).
 *
 * **One pure answer, and nothing asked of anybody.** Every row the design calls
 * fast is filled from the repository; the slow ones (`gates.merge`,
 * `runtime.limits`) are left at the schema's defaults for a person to decide.
 * Where the repository does not settle a row, the answer still parses and the
 * doubt goes into `refusals`, so the page can ask rather than this guess quietly.
 *
 * **It writes nothing.** Every request is a `GET`; labels are not created,
 * because GitHub creates one the first time it is applied, and a recipe naming
 * `agent:hold` before anyone has used it is none the worse for it. The recipe
 * belongs to the repository (0005), which is why this proposes and never saves.
 */
import type { RuntimeId } from "@lingtai/domain";
import { Recipe } from "./recipe.ts";

/**
 * The part of `@lingtai/github`'s client this reads through — structurally, so
 * the recipe package takes no dependency on the network one. A `GitHubClient`
 * is one.
 */
export interface RepositoryReader {
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
}

/** One script in one `package.json`, and whether the proposal picked it. */
export interface FoundScript {
  /** The directory holding the `package.json`, `""` for the root. */
  dir: string;
  name: string;
  /** What the script itself says. */
  command: string;
  /** How a gate at the repository root would run it. */
  run: string;
  /** Picked into `gates.proposed`. An unpicked one is an empty checkbox, not an omission. */
  guessed: boolean;
}

export interface Found {
  defaultBranch: string;
  submodules: boolean;
  /** Every label the repository has. */
  labels: string[];
  packageManager: "pnpm" | "yarn" | "npm" | null;
  /** Every script in every `package.json`, root first. */
  scripts: FoundScript[];
  /** Each `.env.example`, and the names in it — never a value. */
  envExamples: { path: string; names: string[] }[];
  /** The runtime `runtime.agent` names, or null when none was signed in. */
  runtime: RuntimeId | null;
}

export interface Proposal {
  recipe: Recipe;
  found: Found;
  refusals: string[];
}

export interface ProposeOptions {
  /**
   * The runtimes signed in on this machine, as `lingtai doctor`'s
   * `runtime: signed in` detects them. Passed in so this stays one answer about
   * a repository, with no process spawned to reach it.
   */
  signedIn?: readonly RuntimeId[];
}

/** Work kinds a repository's labels are matched against, most wanted first. */
export const PROPOSED_KINDS = ["bug", "feature", "tech-debt"] as const;

/**
 * Holds, recommended whether or not the labels exist yet — the set Lingtai's
 * own recipe uses.
 */
export const PROPOSED_EXCLUDE = [
  "blocked",
  "in-progress",
  "agent:hold",
  "agent:blocked",
  "agent:review",
  "agent:wip",
  "epic",
] as const;

/**
 * A script that checks a diff: a type check, a lint, a test or a named half of
 * one (`test:db`). A script that never exits (`test:watch`) or needs a person
 * (`test:ui`) is found and not picked.
 */
const CHECK = /^(typecheck|type-check|check-types|tsc|lint|test|test:[\w:.-]+|check|verify)$/;
const NOT_A_CHECK = /(watch|:ui$|:dev$|coverage)/;

/** In the order a gate should run them: cheapest refusal first. */
function checkRank(name: string): number {
  if (/^(typecheck|type-check|check-types|tsc)$/.test(name)) return 0;
  if (name === "lint") return 1;
  if (name === "test") return 2;
  return 3;
}

/** A root script that fans out to the workspace, so its name covers the packages'. */
const RECURSIVE = /(\s-r\b|--recursive|--filter|\bworkspaces?\b|\bturbo\b|\bnx\b|\blerna\b)/;

const LABEL_PAGES = 10;

export async function proposeRecipe(
  slug: string,
  client: RepositoryReader,
  options: ProposeOptions = {},
): Promise<Proposal> {
  const m = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(slug.trim());
  if (!m) throw new Error(`"${slug}" is not owner/repo`);
  const repoPath = `/repos/${m[1]}/${m[2]}`;
  const get = <T>(path: string) => client.request<T>("GET", `${repoPath}${path}`);
  const refusals: string[] = [];

  const { default_branch: base } = await get<{ default_branch: string }>("");

  const labels: string[] = [];
  for (let page = 1; page <= LABEL_PAGES; page++) {
    const batch = await get<{ name: string }[]>(`/labels?per_page=100&page=${page}`);
    labels.push(...batch.map((l) => l.name));
    if (batch.length < 100) break;
  }

  // One listing of every path at the base, so a monorepo's nested files are
  // found by the same read as the root's.
  const tree = await get<{ tree: { path: string; type: string }[]; truncated?: boolean }>(
    `/git/trees/${encodeURIComponent(base)}?recursive=1`,
  );
  if (tree.truncated) {
    refusals.push(
      "the repository's file listing was truncated by GitHub, so a package.json or .env.example may have been missed",
    );
  }
  const paths = new Set(tree.tree.filter((e) => e.type === "blob").map((e) => e.path));

  const read = async (path: string): Promise<string | null> => {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    try {
      const raw = await get<{ content?: string; encoding?: string }>(
        `/contents/${encoded}?ref=${encodeURIComponent(base)}`,
      );
      if (!raw.content) return null;
      return Buffer.from(raw.content, (raw.encoding as BufferEncoding) ?? "base64").toString("utf8");
    } catch (err) {
      if ((err as { status?: number }).status === 404) return null;
      throw err;
    }
  };

  // --- repo.submodules ------------------------------------------------------
  const submodules = paths.has(".gitmodules");

  // --- source.kinds ---------------------------------------------------------
  const kinds = PROPOSED_KINDS.flatMap((kind) => {
    const label = labels.find((l) => l.toLowerCase() === kind);
    return label === undefined ? [] : [label];
  });
  if (kinds.length === 0) {
    refusals.push(
      `none of this repository's labels is ${PROPOSED_KINDS.join(", ")}, so no issue is work yet — ` +
        `the proposal names all three, and which of the repository's own labels mean work is a question for a person`,
    );
  }

  // --- gates.proposed -------------------------------------------------------
  const packageManager = paths.has("pnpm-lock.yaml")
    ? "pnpm"
    : paths.has("yarn.lock")
      ? "yarn"
      : paths.has("package-lock.json") || paths.has("package.json")
        ? "npm"
        : null;

  const manifests = [...paths]
    .filter((p) => p === "package.json" || p.endsWith("/package.json"))
    .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));

  const scripts: FoundScript[] = [];
  for (const manifest of manifests) {
    const text = await read(manifest);
    if (text === null) continue;
    let parsed: { scripts?: Record<string, unknown> };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      refusals.push(`${manifest} does not parse, so its scripts are not listed`);
      continue;
    }
    const dir = manifest === "package.json" ? "" : manifest.slice(0, -"/package.json".length);
    for (const [name, command] of Object.entries(parsed.scripts ?? {})) {
      if (typeof command !== "string") continue;
      scripts.push({ dir, name, command, run: runFor(packageManager ?? "npm", dir, name), guessed: false });
    }
  }

  const isCheck = (s: FoundScript) => CHECK.test(s.name) && !NOT_A_CHECK.test(s.name);
  const rootChecks = scripts.filter((s) => s.dir === "" && isCheck(s));
  const nestedChecks = scripts.filter((s) => s.dir !== "" && isCheck(s));

  if (rootChecks.length > 0) {
    for (const s of rootChecks) s.guessed = true;
    // The `test:db` case: a half a package runs that no root script names is a
    // half the root's gate silently drops.
    const rootNames = new Set(rootChecks.map((s) => s.name));
    const uncovered = nestedChecks.filter((s) => !rootNames.has(s.name));
    for (const s of uncovered) {
      refusals.push(
        `${s.dir} has a \`${s.name}\` script that no root script runs by name — it is listed and not picked, ` +
          `so a person has to say whether the root's checks cover it`,
      );
    }
    const shallow = rootChecks.filter((s) => !RECURSIVE.test(s.command));
    if (nestedChecks.length > 0 && shallow.length > 0 && uncovered.length === 0) {
      refusals.push(
        `the root's ${shallow.map((s) => `\`${s.name}\``).join(", ")} do not look like they run the workspace's packages, ` +
          `which have checks of their own — picked, and worth a person confirming`,
      );
    }
  } else if (nestedChecks.length > 0) {
    refusals.push(
      `the root has no check scripts and ${new Set(nestedChecks.map((s) => s.dir)).size} package(s) have their own — ` +
        `none is picked, because which of them make up the build is not something to guess`,
    );
  } else {
    refusals.push("no check scripts were found — nothing would check a diff before it merges");
  }

  const picked = scripts.filter((s) => s.guessed).sort((a, b) => checkRank(a.name) - checkRank(b.name));
  const proposed =
    picked.length === 0 ? [] : [{ name: "build", run: picked.map((s) => s.run).join(" && "), timeout: "20m", env: [] }];

  // --- env.required ---------------------------------------------------------
  const envExamples: Found["envExamples"] = [];
  for (const path of [...paths].filter((p) => p === ".env.example" || p.endsWith("/.env.example")).sort()) {
    const text = await read(path);
    if (text !== null) envExamples.push({ path, names: envNames(text) });
  }
  const required = [...new Set(envExamples.flatMap((e) => e.names))];
  const exampleDirs = [...new Set(envExamples.map((e) => e.path.slice(0, -".env.example".length)))];
  if (exampleDirs.length > 1) {
    refusals.push(
      `.env.example is in ${exampleDirs.length} places (${envExamples.map((e) => e.path).join(", ")}) — ` +
        `the names are merged, and where the env file is planted is a question for a person`,
    );
  }
  const plantAt = `${exampleDirs.length === 1 ? exampleDirs[0] : ""}.env.local`;

  // --- runtime.agent --------------------------------------------------------
  const signedIn = options.signedIn ?? [];
  const runtime: RuntimeId | null = signedIn.includes("claude-code")
    ? "claude-code"
    : signedIn.includes("codex")
      ? "codex"
      : null;
  if (runtime === null) {
    refusals.push("no agent runtime is signed in on this machine — `lingtai doctor` says which is missing");
  }

  const recipe = Recipe.parse({
    version: 1,
    repo: { base, submodules },
    source: { kinds: kinds.length > 0 ? kinds : [...PROPOSED_KINDS], exclude: [...PROPOSED_EXCLUDE] },
    env: { required, plantAt },
    gates: {
      proposed,
      end: [{ name: "close the ticket", when: "landed", close: true }],
    },
    runtime: { agent: runtime ?? "claude-code" },
  });

  return {
    recipe,
    found: { defaultBranch: base, submodules, labels, packageManager, scripts, envExamples, runtime },
    refusals,
  };
}

/** The names a `.env.example` declares. The value side of each line is never read into anything. */
export function envNames(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m && !names.includes(m[1]!)) names.push(m[1]!);
  }
  return names;
}

function depth(path: string): number {
  return path.split("/").length;
}

function runFor(pm: "pnpm" | "yarn" | "npm", dir: string, name: string): string {
  if (dir === "") return pm === "npm" ? `npm run ${name}` : `${pm} ${name}`;
  if (pm === "pnpm") return `pnpm --dir ${dir} ${name}`;
  if (pm === "yarn") return `yarn --cwd ${dir} ${name}`;
  return `npm --prefix ${dir} run ${name}`;
}
