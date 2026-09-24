/**
 * The recipe view (#218): what a project is configured to do, and which file
 * each value came from.
 *
 * the-bar.md moved `<project>: rounds ×N` off the row *to the recipe view*, and
 * the view did not exist — so the fact left the board and arrived nowhere. The
 * assertions are about the two things a page showing a recipe could have that a
 * terminal does not, and about the one thing it must not have:
 *
 * - **every row names its source**, which is the column `lingtai doctor` has
 *   and no surface with a screen ever has. `~/.lingtai/<project>/recipe.yml`
 *   and `~/.lingtai/config.yml` both decide one project, and `provenance` is
 *   the only thing that says which won;
 * - **a recipe that will not parse says so, naming the file** — the failure
 *   that cost this project a whole queue while every surface rendered as though
 *   there were simply nothing to do (#76);
 * - **nothing writes.** 0046 §4 retired `tamper` on the grounds that the recipe
 *   is outside every worktree and nothing an agent can reach may write it. A
 *   board that could write it is a process that can, reachable over HTTP from
 *   the machine an agent runs on. That is asserted against the file rather than
 *   against today's markup, because it is a claim about the route.
 *
 * The recipe is resolved for real, from a `LINGTAI_HOME` of two files, because
 * provenance is the whole subject and a fake one would assert the fake.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectState } from "@lingtai/domain";
import { projectRecipe, sourceOf, type ProjectRecipe } from "../src/lib/recipe.ts";
import { Recipe } from "../src/app/recipe/[project]/page.tsx";

const RECIPE = `
version: 2
repo: { base: main }
source: { kinds: [bug, tech-debt], exclude: ["blocked", "agent:hold"] }
env: { plantAt: .env.local }
steps:
  proposed:
    - { name: build, run: "pnpm test", timeout: 20m }
`;

/**
 * The same recipe saying out loud two things `RECIPE` leaves to the schema —
 * `source.backoff`, and two of `runtime.budget`'s four numbers. Both files
 * resolve to the same shape; only provenance can tell them apart.
 */
const SPEAKS = `
version: 2
repo: { base: main }
source: { kinds: [bug], exclude: ["blocked"], backoff: 30m }
env: { plantAt: .env.local }
steps:
  proposed:
    - { name: build, run: "pnpm test", timeout: 20m }
runtime:
  budget: { attempts: 9, diff: 1000 }
`;

/**
 * A recipe that leaves to a preset the one thing the page is most read for.
 * No `gates:`, no `exclude:`, no `required:` — so the three keys with a schema
 * default are all silent, and `gates` has the preset underneath it besides.
 */
const EXTENDS = `
version: 2
extends: pnpm-workspace
repo: { base: main }
source: { kinds: [bug] }
env: { plantAt: .env.local }
`;

/** A machine that says some of it machine-wide and some of it for this project. */
const MACHINE = `
runtime:
  agent: claude-code
  limits: { rounds: 3 }
projects:
  app:
    runtime:
      limits: { turns: 150 }
`;

const PAGE = new URL("../src/app/recipe/[project]/page.tsx", import.meta.url);
const state = { project: "app", owner: "me", base: "main" } as ProjectState;
const render = (view: ProjectRecipe) => renderToStaticMarkup(<Recipe view={view} />);
const sourceIn = (view: ProjectRecipe, name: string) =>
  view.ok ? sourceOf(view.rows.find((row) => row.name === name)!, view.provenance) : null;

let home: string;
let saved: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "lingtai-recipe-view-"));
  await mkdir(join(home, "app"));
  await writeFile(join(home, "app", "recipe.yml"), RECIPE);
  await writeFile(join(home, "config.yml"), MACHINE);
  saved = process.env["LINGTAI_HOME"];
  process.env["LINGTAI_HOME"] = home;
});

afterEach(async () => {
  if (saved === undefined) delete process.env["LINGTAI_HOME"];
  else process.env["LINGTAI_HOME"] = saved;
  await rm(home, { recursive: true, force: true });
});

describe("what a project's recipe says today", () => {
  it("reads in lingtai status's rows and its words", async () => {
    const html = render(await projectRecipe(state));

    expect(html).toContain("<dt>picks up</dt>");
    expect(html).toContain("bug &gt; tech-debt (in priority order)");
    expect(html).toContain("blocked, agent:hold");
    // `describeAssignee`'s sentence, not a second wording of it.
    expect(html).toContain("any issue, whoever it is assigned to");
    // All ten steps, including the nine nothing is configured at (0016 §4,
    // 0061 §5). The unit twin of this assertion is in `run-recipe.test.tsx`.
    expect(html).toContain(
      "claim 0 · admit 0 · prepared 0 · design 0 · implement 0 · build 0 · review 0 · proposed 1 · merge 0 · end 0",
    );
    // `passCeiling`'s sentence, which is what `lingtai status` prints.
    expect(html).toContain("150 turns");
  });

  /**
   * The claim the whole page is for. Asserted over the rows rather than over
   * the markup, so a row added later with nothing in `keys` fails here instead
   * of rendering a blank column nobody notices.
   */
  it("names a source for every value, and not one source for all of them", async () => {
    const view = await projectRecipe(state);
    if (!view.ok) throw new Error(view.problem);

    for (const row of view.rows) {
      expect(sourceOf(row, view.provenance), `${row.name} has no source`).not.toBeNull();
    }

    const of = (name: string) => sourceOf(view.rows.find((r) => r.name === name)!, view.provenance);
    // The three places, told apart: the project's own file, the machine's, and
    // the machine's per-project section.
    expect(of("picks up")).toBe(join(home, "app", "recipe.yml"));
    expect(of("agent")).toBe(join(home, "config.yml"));
    // `a pass` is four limits from three places, and says all three: one
    // source printed there would be a sentence true of a number it is not
    // made of.
    expect(of("a pass")).toContain("(projects.app)");
    expect(of("a pass")).toContain("default");
  });

  /**
   * **A source column can be worse than blank, and this is how.** `source.backoff`
   * and every number in `runtime.budget` have a schema default, so the resolved
   * recipe reads `1h` and `attempts 5` whether the file says so or not — and a
   * line naming `recipe.yml` for a value that file does not contain sends its
   * reader to open it and find no `budget:` block at all. Asserted both ways
   * round, because `default` everywhere would pass one half of it.
   */
  it("says default for a value the file leaves to the schema, and the file for one it carries", async () => {
    const silent = await projectRecipe(state);

    expect(sourceIn(silent, "retries")).toBe("default");
    expect(sourceIn(silent, "budget")).toBe("default");

    await writeFile(join(home, "app", "recipe.yml"), SPEAKS);
    const speaks = await projectRecipe(state);
    const file = join(home, "app", "recipe.yml");

    expect(sourceIn(speaks, "retries")).toBe(file);
    // Two of the four numbers are this file's and two are the schema's, and the
    // row says both — `a pass`'s rule, for the same reason.
    expect(sourceIn(speaks, "budget")).toContain(file);
    expect(sourceIn(speaks, "budget")).toContain("default");
    // Per field in the block below too, so which two is a thing a reader can see.
    expect(render(speaks)).toContain("runtime.budget.attempts");
  });

  /**
   * **The row this page exists for, and the one with a third origin.** `gates`
   * has a schema default *and* can come from a preset, so `the points` is the
   * one row on the page whose answer may be in neither file: a reader asking
   * where the `proposed: build` gate came from opens `recipe.yml`, finds no
   * `gates:` block, and has nowhere left to look unless the page names
   * `extends:`'s preset. `excludes` is the same schema default without the
   * preset, and both used to read `← ~/.lingtai/app/recipe.yml`.
   */
  it("names the preset for the points it decided, and the schema for what neither file says", async () => {
    await writeFile(join(home, "app", "recipe.yml"), EXTENDS);
    const view = await projectRecipe(state);
    const file = join(home, "app", "recipe.yml");

    expect(sourceIn(view, "the points")).toBe("preset pnpm-workspace");
    expect(sourceIn(view, "the points")).not.toContain(file);
    expect(sourceIn(view, "excludes")).toBe("default");
    // The page says it where a reader is looking — beside the row, and in the
    // exhaustive block under it, which carries `env.required` too.
    const html = render(view);
    expect(html).toContain(
      "claim 0 · admit 0 · prepared 1 · design 0 · implement 0 · build 0 · review 0 · proposed 1 · merge 0 · end 0",
    );
    expect(html).toContain("← preset pnpm-workspace");
    expect(sourceIn(view, "excludes")).not.toContain(file);

    // And with no preset either, ten empty steps are the schema's.
    await writeFile(join(home, "app", "recipe.yml"), EXTENDS.replace("extends: pnpm-workspace\n", ""));
    expect(sourceIn(await projectRecipe(state), "the points")).toBe("default");
  });

  /** So a reader can hold this against an attempt's recorded recipe (#217). */
  it("shows the hash and the base branch the recipe governs", async () => {
    const view = await projectRecipe(state);
    if (!view.ok) throw new Error(view.problem);

    expect(render(view)).toContain(`recipe ${view.configHash.slice(0, 12)} · base main`);
  });

  /** `repo.base` and `env.required` are in no row above, and are here. */
  it("carries doctor's whole provenance block, not only the rows it grouped", async () => {
    const html = render(await projectRecipe(state));

    expect(html).toContain("repo.base");
    expect(html).toContain("env.required");
    expect(html).toContain("runtime.limits.restarts");
  });
});

describe("a recipe that cannot be read", () => {
  it("names the file and the fault, rather than rendering an empty page", async () => {
    await writeFile(join(home, "app", "recipe.yml"), "version: 2\nsource: { kinds: 42 }\n");
    const view = await projectRecipe(state);
    const html = render(view);

    expect(view.ok).toBe(false);
    expect(html).toContain(join(home, "app", "recipe.yml"));
    expect(html).toContain("is not valid");
    // Not a page of empty rows pretending the recipe said nothing.
    expect(html).not.toContain("<dt>picks up</dt>");
    expect(html).toContain("nothing will be taken from this project");
  });

  it("says so for a project with no recipe at all, by its path", async () => {
    await rm(join(home, "app", "recipe.yml"));
    const html = render(await projectRecipe(state));

    expect(html).toContain(join(home, "app", "recipe.yml"));
    expect(html).toContain("could not be read");
  });

  /**
   * **And when the fault is in the other file, it says that one.** `gates:` in
   * the machine file is the mistake that file exists to refuse, and it stops
   * the resolve with `recipe.yml` perfectly readable — as an ill-formed
   * `runtime.assignee` does, and as `AgentUnresolvedError` does. A page
   * answering all three with *the recipe could not be read* and then *edit the
   * recipe* costs its reader two readings of the one file there is nothing
   * wrong with.
   */
  it("names the machine's file when the fault is there, and sends nobody to the recipe", async () => {
    await writeFile(join(home, "config.yml"), `${MACHINE}\ngates:\n  proposed: []\n`);
    const view = await projectRecipe(state);
    const html = render(view);

    expect(view.ok).toBe(false);
    if (view.ok) return;
    expect(view.fault).toBe("machine");
    expect(view.at).toBe(join(home, "config.yml"));
    expect(html).toContain("a pass is not configured in the machine file");
    expect(html).not.toContain("could not be read");
    // The note is rendered in every state, and it is the line that says what to
    // edit — so it is the line that must not name the wrong file.
    const note = html.slice(html.indexOf("Read-only."));
    expect(note).toContain(join(home, "config.yml"));
    expect(note).not.toContain(join(home, "app", "recipe.yml"));
  });

  /**
   * **And a value the reading has to parse is the machine's too.** `wall: "90"`
   * — the unit forgotten — used to resolve, because nothing refined it as a
   * duration: the throw came afterwards, out of `parseDuration` inside
   * `readRecipe`, and was caught beside the resolve's own errors and sorted by
   * `faultOf`'s `else` into `fault: "recipe"`. The page then named
   * `~/.lingtai/app/recipe.yml`, which may not carry `runtime.limits` at all
   * (0046 §3) — so its reader opened that file twice, found no `limits:` block,
   * and was never told about the one file to edit.
   */
  it("names the machine's file for a wall that is not a duration, and never the recipe", async () => {
    await writeFile(join(home, "config.yml"), `runtime:\n  agent: claude-code\n  limits: { wall: "90" }\n`);
    const view = await projectRecipe(state);
    const html = render(view);

    expect(view.ok).toBe(false);
    if (view.ok) return;
    expect(view.fault).toBe("machine");
    expect(view.at).toBe(join(home, "config.yml"));
    expect(html).toContain("must be a positive duration");
    expect(html).not.toContain(join(home, "app", "recipe.yml"));
    // The line that says what to edit is the line that must not send a reader
    // to the file with nothing wrong in it.
    const note = html.slice(html.indexOf("Read-only."));
    expect(note).toContain(join(home, "config.yml"));
  });

  /** The same file, refused by the schema rather than by name. */
  it("names the machine's file for an assignee it will not accept", async () => {
    await writeFile(join(home, "config.yml"), `runtime:\n  agent: claude-code\n  assignee: { take: nobody }\n`);
    const view = await projectRecipe(state);

    expect(view.ok).toBe(false);
    if (view.ok) return;
    expect(view.fault).toBe("machine");
    expect(view.at).toBe(join(home, "config.yml"));
  });
});

/**
 * **Nothing writes**, and the claim is about the route rather than about the
 * markup a particular view happens to produce (0046 §4).
 *
 * **Which means the whole segment, and not one `page.tsx`.** A `page.tsx`
 * never serves a method and a `route.ts` cannot sit in the same segment as
 * one, so a guard that greps this file for `export async function POST` is a
 * guard whose failing half cannot fail. What #206 would actually add is
 * `recipe/[project]/apply/route.ts` — a segment *under* this one — or a
 * `"use server"` module the page imports; so the scan is the segment's whole
 * tree for a handler, a filesystem write and a server directive, and the
 * page's imports followed through for the directive, since a server action is
 * a writer reachable over HTTP wherever the file holding it sits.
 */
describe("read-only", () => {
  const page = fileURLToPath(PAGE);
  const segment = filesUnder(new URL("../src/app/recipe/", import.meta.url));
  const reached = importedBy(page);

  /** A scan that found nothing would pass every assertion below saying nothing. */
  it("is reading the route, and what the route pulls in", () => {
    expect(segment).toContain(page);
    expect(reached).toContain(fileURLToPath(new URL("../src/lib/recipe.ts", import.meta.url)));
  });

  it("exports no method handler anywhere under the segment", () => {
    for (const file of segment) {
      const text = readFileSync(file, "utf8");
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        expect(text, file).not.toMatch(
          new RegExp(String.raw`export\s+(?:async\s+)?(?:function|const)\s+${method}\b`),
        );
      }
    }
  });

  it("declares no server action, in the segment or in anything the page imports", () => {
    for (const file of new Set([...segment, ...reached])) {
      expect(readFileSync(file, "utf8"), file).not.toContain("use server");
    }
    // The board's one writer is `app/actions.ts`; nothing here imports it.
    for (const file of segment) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/from\s+["'][^"']*actions["']/);
    }
  });

  it("touches no filesystem under the segment", () => {
    for (const file of segment) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/from\s+["']node:fs(?:\/promises)?["']/);
      expect(text, file).not.toMatch(/\bwriteFile(?:Sync)?\b/);
    }
  });

  it("renders nothing to press, in every state", async () => {
    const states: ProjectRecipe[] = [
      await projectRecipe(state),
      { ok: false, project: "app", at: "/x", fault: "recipe", problem: "no" },
      { ok: false, project: "app", at: "/y", fault: "machine", problem: "no" },
    ];
    for (const html of states.map(render)) {
      expect(html).not.toContain("<form");
      expect(html).not.toContain("<button");
      expect(html).not.toContain("<input");
      expect(html).not.toContain("action=");
    }
  });
});

/** Every file in a directory tree — a segment added under this one is the route too. */
function filesUnder(dir: URL): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

/**
 * The local modules an entry file pulls in, followed through.
 *
 * Only this app's own files: a bare specifier is a package, and a package
 * cannot be a Next.js server action. Extension-less and `@/`-aliased
 * specifiers both resolve, because that is how the app writes them.
 */
function importedBy(entry: string, seen = new Set<string>()): string[] {
  if (seen.has(entry)) return [...seen];
  seen.add(entry);
  for (const [, spec = ""] of readFileSync(entry, "utf8").matchAll(/from\s+["']([^"']+)["']/g)) {
    const next = localModule(spec, entry);
    if (next !== null) importedBy(next, seen);
  }
  return [...seen];
}

function localModule(spec: string, from: string): string | null {
  const base = spec.startsWith("@/")
    ? fileURLToPath(new URL(spec.slice(2), new URL("../src/", import.meta.url)))
    : spec.startsWith(".")
      ? join(dirname(from), spec)
      : null;
  if (base === null) return null;
  const tried = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")];
  return tried.find((path) => existsSync(path) && statSync(path).isFile()) ?? null;
}
