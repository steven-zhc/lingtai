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
    files: ["tutorial.md", "guide.md", "operating.md", "reference.md", "design.md", "roadmap.md"],
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
 * Some documents are drawings, and a drawing is not markdown.
 *
 * Each is hand-written HTML with its own diagrams and its own stylesheet, so
 * rendering one through this pipeline would mean rewriting it — which is the
 * fork this file exists to avoid. The build copies them to `public/doc/`
 * instead (`scripts/doc-assets.ts`) and the site links to them. Same bytes,
 * different route.
 *
 * **This list is the whole of what makes one reachable.** `doc-assets.ts`
 * copies what is here, `/docs` indexes what is here, and `resolveHref` sends a
 * link to the copy because the file is here — so a drawing added to `doc/` and
 * not to this list is one every link silently sends to GitHub instead.
 */
export const HTML_DOCS = [
  { file: "architecture.html", label: "Architecture", note: "One page, six diagrams: which process am I in, who appends to the log, who is told when it changes, and where each piece of state lives." },
  { file: "architecture.zh.html", label: "架构", note: "The architecture page, in Chinese. A change to either belongs in both." },
  { file: "the-pass.html", label: "The Pass", note: "One pass from claim to end, and where a refusal goes. Draws 0039, which is accepted and not yet built — the two places it is ahead of the code are marked on it." },
  { file: "the-pass.zh.html", label: "一趟 pass", note: "The pass page, in Chinese. Both are generated from one geometry, so a change belongs in both." },
];

/**
 * The six the front page offers, and no more.
 *
 * The index at `/docs` is generated and lists everything in `doc/`; six is a
 * choice about where a stranger should start, so it is written down rather than
 * derived. What it must not become is a list that outlives what it points at —
 * `test/page.test.ts` checks that each `source` is still in `doc/` and that
 * each `href` is a page this site publishes, which is the same failure the
 * generated index exists to avoid, one level up.
 */
export const FRONT_PAGE_DOCS = [
  {
    title: "Tutorial",
    href: "/docs/tutorial/",
    source: "tutorial.md",
    note: "From a clone to a merged ticket, on your own repository.",
  },
  {
    title: "Architecture",
    href: "/doc/architecture.html",
    source: "architecture.html",
    note: "Six diagrams answering which process am I in, who appends to the log, and where each piece of state lives.",
  },
  {
    title: "Reference",
    href: "/docs/reference/",
    source: "reference.md",
    note: "Every term, every event, every recipe key, and what each default is for.",
  },
  {
    title: "Operating",
    href: "/docs/operating/",
    source: "operating.md",
    note: "Running it day to day: pausing, shutting down, watching a run, and what to do when one is stuck.",
  },
  {
    title: "Decisions",
    href: "/docs/#decisions",
    source: "decisions",
    note: "One decision per file, with its context and its consequences. A decision that turns out wrong gets a superseding file, not an edit.",
  },
  {
    title: "Experiments",
    href: "/docs/#experiments",
    source: "experiments",
    note: "Things actually run against real data, with their results — including the ones that did not work.",
  },
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
  /** The date the file states, which for a decision is when it was decided. */
  decided: string | null;
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
      return { slug, title: titleOf(body, slug), source: file, lede: ledeOf(body), decided: decidedOn(body) };
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
 * - a drawing in `HTML_DOCS` → the copy the build put in `public/doc/`
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
  if (HTML_DOCS.some((d) => d.file === rel)) return `/doc/${rel}${suffix}`;
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

/**
 * The anchor a heading gets, in GitHub's dialect and not one of this site's own.
 *
 * `doc/operating.md` links to `#onboarding-a-repository` and `doc/design.md` to
 * `#8-deliberately-not-building`, and those anchors were written against the
 * files as GitHub renders them. A slug of this site's own devising would mean
 * either broken links here or an edit to the documents to suit the site, and
 * the second is the fork the module refuses. So: lower case, punctuation
 * dropped, spaces to hyphens — which is what GitHub does.
 *
 * Each space, not each run of them: `## event — 43 types` loses the em dash and
 * keeps the two spaces around it, so the anchor is `event--43-types`. It looks
 * like a typo and it is what a link copied from GitHub says.
 */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
    .replace(/\s/gu, "-");
}

export interface Heading {
  depth: number;
  text: string;
  id: string;
  /** 1-based, so the renderer can match a heading to its element by position. */
  line: number;
}

/**
 * A document's own headings, which is the only table of contents there can be.
 *
 * `reference.md` is 559 lines and thirty terms; read as one scroll it is a
 * document you search rather than one you use. The contents that fixes that has
 * to come out of the file — a list of sections maintained beside it is a second
 * copy of its structure, and would be wrong the first time a term is added.
 *
 * `##` through `####`: `#` is the document's title, which the page shows
 * anyway. `####` earns its id rather than a line in the contents — `doc/operating.md`
 * links twice to `#### The layers`, so a projection that only gave `##` and
 * `###` an anchor would break a link that works in the repository. What the
 * contents *lists* is a separate question, and `Contents` answers it.
 * Headings inside a fenced code block are text that happens to start with a
 * hash, and are skipped.
 *
 * The line number is carried because it is what makes the ids here and the ids
 * in the rendered HTML the same ids. See `Document`.
 */
export function headingsOf(body: string): Heading[] {
  const out: Heading[] = [];
  const seen = new Map<string, number>();
  const lines = body.split("\n");
  let fence: string | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? "";
    const marker = /^\s{0,3}(```+|~~~+)/.exec(raw)?.[1];
    if (marker !== undefined) {
      if (fence === null) fence = marker;
      else if (marker.startsWith(fence[0] ?? "")) fence = null;
      continue;
    }
    if (fence !== null) continue;

    const heading = /^(#{2,4})\s+(.+?)\s*#*\s*$/.exec(raw);
    const hashes = heading?.[1];
    const label = heading?.[2];
    if (hashes === undefined || label === undefined) continue;

    const text = flatten(label);
    const base = slugify(text);
    // GitHub's own de-duplication: a second `## Done when` in one file is
    // `#done-when-1`. Two headings sharing an id would send both contents
    // entries to the first one.
    const nth = seen.get(base) ?? 0;
    seen.set(base, nth + 1);
    out.push({ depth: hashes.length, text, id: nth === 0 ? base : `${base}-${nth}`, line: index + 1 });
  }

  return out;
}

/**
 * The date a document states, which for an ADR is the date it was decided.
 *
 * Taken from the file's own opening — `**2026-09-02. Accepted.**`, or
 * `**Status** accepted · 2026-09-02 · supersedes …`. Every ADR in this
 * repository carries one in its first few lines; the date is not stored here,
 * because a date maintained beside a document is a fact that can disagree with
 * it. Null when the file states none, and then the page says nothing rather
 * than guessing.
 */
export function decidedOn(body: string): string | null {
  const head = body.split("\n").slice(0, 12).join("\n");
  return /\b(20\d{2}-\d{2}-\d{2})\b/.exec(head)?.[1] ?? null;
}

/**
 * Every decision by its number — `0016` → `decisions/0016-the-settled-model`.
 *
 * Built from the directory, so a decision that names a decision in its status
 * links to it without either file being edited.
 */
export async function decisionsByNumber(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const file of await markdownIn("decisions")) {
    const number = /(\d{4})-/.exec(path.posix.basename(file))?.[1];
    if (number !== undefined) out.set(number, slugOf(file));
  }
  return out;
}

export interface StatusPart {
  text: string;
  /** Set when this part is a decision number the site has a page for. */
  href?: string;
}

/**
 * `superseded by 0016` with the `0016` made a link, and nothing else changed.
 *
 * The status is `doc/README.md`'s sentence, carried word for word. The one
 * thing added is the link, because a reader told a decision was superseded and
 * not told where to has been told the least useful half of it — and being able
 * to follow *what replaced this* is the whole reason the ADRs are append-only.
 */
export function statusParts(
  status: string,
  hrefOf: (number: string) => string | null,
): StatusPart[] {
  const out: StatusPart[] = [];
  for (const piece of status.split(/(\d{4})/)) {
    if (piece === "") continue;
    const href = /^\d{4}$/.test(piece) ? hrefOf(piece) : null;
    out.push(href === null ? { text: piece } : { text: piece, href });
  }
  return out;
}
