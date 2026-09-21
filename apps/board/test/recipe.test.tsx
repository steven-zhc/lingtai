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
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectState } from "@lingtai/domain";
import { projectRecipe, sourceOf, type ProjectRecipe } from "../src/lib/recipe.ts";
import { Recipe } from "../src/app/recipe/[project]/page.tsx";

const RECIPE = `
version: 1
repo: { base: main }
source: { kinds: [bug, tech-debt], exclude: ["blocked", "agent:hold"] }
env: { plantAt: .env.local }
gates:
  proposed:
    - { name: build, run: "pnpm test", timeout: 20m }
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
    // All five points, including the four nothing is configured at (0016 §4).
    expect(html).toContain("admit 0 · prepared 0 · proposed 1 · merge 0 · end 0");
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
    await writeFile(join(home, "app", "recipe.yml"), "version: 1\nsource: { kinds: 42 }\n");
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
});

/**
 * **Nothing writes**, and the claim is about the route rather than about the
 * markup a particular view happens to produce (0046 §4). Both halves are
 * asserted: the file exports no handler and contains no form, and a rendered
 * page has nothing to press.
 */
describe("read-only", () => {
  const source = readFileSync(PAGE, "utf8");

  it("exports no method handler and declares no server action", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(source).not.toContain(`export async function ${method}`);
      expect(source).not.toContain(`export function ${method}`);
    }
    expect(source).not.toContain("use server");
    // The board's one writer is `app/actions.ts`; this route does not import it.
    expect(source).not.toMatch(/from\s+["'][^"']*actions["']/);
  });

  it("renders nothing to press, in either state", async () => {
    await projectRecipe(state);
    for (const html of [render(await projectRecipe(state)), render({ ok: false, project: "app", at: "/x", problem: "no" })]) {
      expect(html).not.toContain("<form");
      expect(html).not.toContain("<button");
      expect(html).not.toContain("<input");
      expect(html).not.toContain("action=");
    }
  });
});
