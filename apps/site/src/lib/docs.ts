import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * The docs are a projection of `doc/`, and never a copy.
 *
 * `tutorial.md`, `reference.md`, `operating.md`, `decisions/` and
 * `experiments/` are written for the repository and are read from it at build
 * time. Nothing here forks them, and there is no second copy to fall behind:
 * a file edited on `main` is the page the next build serves.
 *
 * That is the same argument [0022](../../../../doc/decisions/0022-the-seams.md)
 * made when it deleted the outbox and the queue cache — two writers to one
 * truth, and the one nobody was watching was the one that went stale.
 * Documentation that drifts from the repository is worse than none, because it
 * is confidently wrong.
 */

/**
 * The repository root, from the directory the build runs in.
 *
 * `process.cwd()` and not `import.meta.url`: Next compiles this module into a
 * chunk under `.next/`, and a path relative to *that* points somewhere that has
 * no `doc/` in it. pnpm runs a package script with the package as the working
 * directory, so this is `apps/site` under `next build`, under `vitest`, and
 * under `node scripts/*.ts`.
 */
export const repoRoot = path.resolve(process.cwd(), "../..");
export const docRoot = path.join(repoRoot, "doc");

/** Where a file that is not projected is read instead. */
export const GITHUB_BLOB = "https://github.com/steven-zhc/lingtai/blob/main/";

export interface Section {
  id: string;
  label: string;
  /** One line: what this section is for, on the docs index. */
  note: string;
  /** Which files it takes, relative to `doc/`. */
  files: string[] | { dir: string };
}

/**
 * What is published, named rather than swept up.
 *
 * A projection that publishes whatever it finds in a directory will one day
 * publish something nobody meant to — `doc/` holds a backlog script and a
 * market study as well as documentation. So the list is explicit.
 *
 * The cost of an allow-list is the thing it silently omits, which is the
 * failure this repository keeps naming: `lingtai doctor` prints an
 * unimplemented check as `skip` rather than leaving it out, because a check you
 * cannot see is a check you will forget you never had. `unpublished()` below is
 * this file paying that same cost — every markdown file in `doc/` that is not
 * in a section here is listed on the docs index, with a link to it on GitHub.
 */
export const SECTIONS: Section[] = [
  {
    id: "guides",
    label: "Guides",
    note: "Written to be read in order. Start at the tutorial.",
    files: ["tutorial.md", "operating.md", "reference.md", "design.md", "roadmap.md"],
  },
  {
    id: "decisions",
    label: "Decisions",
    note: "One decision per file, with its context and its consequences. Append-only in spirit — a decision that turns out wrong gets a superseding file, not an edit.",
    files: { dir: "decisions" },
  },
  {
    id: "experiments",
    label: "Experiments",
    note: "Things actually run against real data, with their results. A design claim backed by one of these is worth more than one backed by argument.",
    files: { dir: "experiments" },
  },
];

/**
 * `architecture.html` is a document and is not markdown.
 *
 * It is 1,000 lines of hand-written HTML with its own diagrams and its own
 * stylesheet, so rendering it through this pipeline would mean rewriting it —
 * which is the fork this file exists to avoid. The build copies the file to
 * `public/doc/` instead (`scripts/doc-assets.ts`) and the site links to it.
 * Same bytes, different route.
 */
export const HTML_DOCS = [
  { file: "architecture.html", label: "Architecture", note: "One page, six diagrams: which process am I in, who appends to the log, who is told when it changes, and where each piece of state lives." },
  { file: "architecture.zh.html", label: "架构", note: "The architecture page, in Chinese. A change to either belongs in both." },
];

export interface DocPage {
  /** The route under `/docs/`, and the file's path under `doc/` without `.md`. */
  slug: string;
  /** Its own `# ` heading, which is what the file calls itself. */
  title: string;
  /** Path relative to `doc/`, so a page can say where it came from. */
  source: string;
  body: string;
}

export interface DocEntry {
  slug: string;
  title: string;
  source: string;
  /** The first paragraph, for the index. Empty when the file opens on a heading. */
  lede: string;
}

async function markdownIn(dir: string): Promise<string[]> {
  const full = path.join(docRoot, dir);
  if (!existsSync(full)) return [];
  const names = await readdir(full);
  return names.filter((n) => n.endsWith(".md")).sort().map((n) => `${dir}/${n}`);
}

/** Every file a section takes, relative to `doc/`, in the order it takes them. */
export async function filesOf(section: Section): Promise<string[]> {
  if (Array.isArray(section.files)) {
    return section.files.filter((f) => existsSync(path.join(docRoot, f)));
  }
  return markdownIn(section.files.dir);
}

/** Every published file, relative to `doc/`. */
export async function published(): Promise<string[]> {
  const all: string[] = [];
  for (const section of SECTIONS) all.push(...(await filesOf(section)));
  return all;
}

/**
 * Every markdown file in `doc/` that no section takes.
 *
 * Not an error and not hidden. `doc/README.md` is the docs index itself, so it
 * is excluded here; anything else that turns up is something a person added and
 * this file has not been told about, and the index says so out loud rather than
 * dropping it.
 */
export async function unpublished(): Promise<string[]> {
  const taken = new Set(await published());
  const found: string[] = [];
  const walk = async (dir: string) => {
    const here = path.join(docRoot, dir);
    for (const entry of await readdir(here, { withFileTypes: true })) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(rel);
      else if (entry.name.endsWith(".md") && rel !== "README.md" && !taken.has(rel)) found.push(rel);
    }
  };
  await walk("");
  return found.sort();
}

export function slugOf(file: string): string {
  return file.replace(/\.md$/, "");
}

/** The file a slug came from. Null when the slug names nothing in `doc/`. */
export function fileOf(slug: string): string | null {
  const file = `${slug}.md`;
  // Refuse anything that climbs out of `doc/`. A slug arrives from a route
  // segment, and `..` in one is how a static export ends up with a page whose
  // content is `/etc/passwd`.
  const full = path.resolve(docRoot, file);
  if (!full.startsWith(docRoot + path.sep)) return null;
  return existsSync(full) ? file : null;
}

export async function readDoc(slug: string): Promise<DocPage | null> {
  const file = fileOf(slug);
  if (file === null) return null;
  const body = await readFile(path.join(docRoot, file), "utf8");
  return { slug, title: titleOf(body, slug), source: file, body };
}

export function titleOf(body: string, fallback: string): string {
  const heading = /^#\s+(.+)$/m.exec(body);
  return heading?.[1]?.trim() ?? fallback;
}

/**
 * The first sentence of prose, for an index that would otherwise be 34 link
 * texts in a column.
 *
 * Taken from the file rather than written here, for the reason the whole module
 * exists: a summary maintained beside a document is a second copy of it.
 */
export function ledeOf(body: string): string {
  const afterTitle = body.replace(/^#\s+.+$/m, "");
  for (const block of afterTitle.split(/\n\s*\n/)) {
    const text = block.trim();
    if (text === "" || text.startsWith("#") || text.startsWith("|") || text.startsWith("```")) continue;
    if (text.startsWith(">") || text.startsWith("-") || text.startsWith("*")) continue;
    return flatten(text);
  }
  return "";
}

/** Markdown inline syntax removed, so a lede can sit in a `<p>` as plain text. */
function flatten(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .trim();
}

export async function entriesOf(section: Section): Promise<DocEntry[]> {
  const files = await filesOf(section);
  return Promise.all(
    files.map(async (file) => {
      const body = await readFile(path.join(docRoot, file), "utf8");
      const slug = slugOf(file);
      return { slug, title: titleOf(body, slug), source: file, lede: ledeOf(body) };
    }),
  );
}

/**
 * Where a link inside a document points once the document is a page.
 *
 * A doc file's links are written for somebody reading the repository: relative
 * paths to other documents, and to source files. Rendered as-is they would 404
 * on the site, and rewriting the files to suit the site is the fork this module
 * refuses. So the projection rewrites the *links* instead, at render:
 *
 * - another projected document → its route here
 * - anything else inside the repository → the file on GitHub, which is where
 *   `packages/domain/src/events.ts` actually is
 * - `architecture.html` → the copy the build put in `public/doc/`
 * - an absolute URL or a bare `#anchor` → untouched
 */
export function resolveHref(fromSlug: string, href: string, isPublished: (file: string) => boolean): string {
  if (href === "" || /^[a-z]+:/i.test(href) || href.startsWith("#") || href.startsWith("//")) return href;

  const fromDir = path.posix.dirname(`${fromSlug}.md`);
  const [target = "", hash] = href.split("#", 2);
  const suffix = hash === undefined ? "" : `#${hash}`;
  // Relative to the document, then relative to `doc/`. A path that climbs out
  // of `doc/` — `../../packages/...`, which several ADRs use — comes back with
  // a leading `../` and is a repository path, not a doc path.
  const rel = path.posix.normalize(path.posix.join(fromDir === "." ? "" : fromDir, target));

  if (rel.startsWith("../")) return GITHUB_BLOB + rel.replace(/^(\.\.\/)+/, "") + suffix;
  if (rel.endsWith(".md") && isPublished(rel)) return `/docs/${slugOf(rel)}/${suffix}`;
  if (rel === "architecture.html" || rel === "architecture.zh.html") return `/doc/${rel}${suffix}`;
  return `${GITHUB_BLOB}doc/${rel}${suffix}`;
}

/**
 * What `doc/README.md` says about each decision — `accepted`, or superseded by
 * a later one.
 *
 * Read out of the index table rather than restated here. The status of an ADR
 * lives in exactly one place in this repository, and a decisions list that
 * showed 0014 and 0016 as equals would be the site quietly disagreeing with the
 * repository about which decisions are in force.
 */
export async function statuses(): Promise<Map<string, string>> {
  const readme = path.join(docRoot, "README.md");
  if (!existsSync(readme)) return new Map();
  const body = await readFile(readme, "utf8");
  const rows = body.matchAll(/^\|\s*\[[^\]]*\]\(([^)]+\.md)\)\s*\|([^|]*)\|([^|]*)\|/gm);
  const out = new Map<string, string>();
  for (const row of rows) {
    const [, file, , status] = row;
    if (file === undefined || status === undefined) continue;
    out.set(slugOf(file), flatten(status));
  }
  return out;
}
