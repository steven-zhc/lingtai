/**
 * Adding a repository from the board, in all three states (#216).
 *
 * The slot the projects live in already was the entry and then stopped being
 * one: with no projects it linked to the wizard, with one it was plain text,
 * and with two it was a filter — so the only routes to a second repository
 * were `lingtai add <owner>/<repo>` and typing `/setup/repository` from
 * memory. The one-project state is the one most installs sit in and the one
 * with nothing at all today, so it is asserted first.
 *
 * Two claims a fold cannot catch, which is why they are markup: **every state
 * can reach the wizard**, and **the target follows the App** rather than
 * whether anything is registered — `filters.length === 0` was the proxy for
 * that and the two come apart in both directions.
 *
 * The third claim is about the row. the-bar.md's *a chip is not free, and the
 * row is the unit* counts the filter among its four, so the `+` is inside the
 * rule and not beside it: what makes it allowed is that the filter was already
 * a list of tabs and gained one more. Nothing opens in `.rail`, the four are
 * still the four, and `bar.test.ts` now reads `projects.tsx` so that a class
 * added here is still a class the bar's amber guard has seen.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Projects } from "../src/app/projects.tsx";

const html = (filters: string[], app: boolean, only?: string) =>
  renderToStaticMarkup(<Projects filters={filters} only={only} app={app} />);

describe("adding a repository from the board", () => {
  /**
   * The state that had neither an entry nor a filter, and the one a board with
   * a single repository — which is most of them — sits in for ever.
   */
  it("offers it beside the one project, which had no affordance at all", () => {
    const out = html(["lingtai"], true);

    expect(out).toContain("lingtai");
    expect(out).toContain('href="/setup/repository"');
  });

  /** A list of things gains the action at its end, however long the list is. */
  it("offers it at the end of the filter, and leaves the filter a filter", () => {
    const out = html(["lingtai", "nextloom-ai-admin"], true, "lingtai");

    expect(out).toContain('href="/"');
    expect(out).toContain('href="/?project=nextloom-ai-admin"');
    expect(out).toContain('href="/setup/repository"');
    // The action is last, after every project.
    expect(out.indexOf('href="/setup/repository"')).toBeGreaterThan(out.indexOf("nextloom-ai-admin"));
  });

  /** #169's slot, unchanged: the sentence is the link, and there is no second one. */
  it("keeps the empty board's one object, and does not add a second beside it", () => {
    const out = html([], false);

    expect(out).toContain("no project configured");
    expect(out).toContain('href="/setup/github-app"');
    expect(out.match(/href=/g)).toHaveLength(1);
  });
});

/**
 * The other thing this list leads to (#218): what the project in view is
 * configured to do. One control and not one per project — the-bar.md moved a
 * chip per project *off* the row, and putting one back inside the filter would
 * be the same act with a different parent.
 */
describe("the recipe view, from the project list", () => {
  it("offers it for the one project a single-project board is showing", () => {
    const out = html(["lingtai"], true);

    expect(out).toContain('href="/recipe/lingtai"');
  });

  it("offers it for the project the filter is on, and names that one", () => {
    const out = html(["lingtai", "nextloom-ai-admin"], true, "nextloom-ai-admin");

    expect(out).toContain('href="/recipe/nextloom-ai-admin"');
    expect(out).not.toContain('href="/recipe/lingtai"');
  });

  /** `all` is not a project, so there is no single recipe to point at. */
  it("offers nothing on all, where there is no one recipe to show", () => {
    const out = html(["lingtai", "nextloom-ai-admin"], true);

    expect(out).not.toContain("/recipe/");
  });

  /** And a board with no project has no recipe either — the slot keeps its one object. */
  it("adds nothing to the empty board", () => {
    expect(html([], true)).not.toContain("/recipe/");
  });
});

describe("where it lands", () => {
  /**
   * The App is the test, not the register. A board that created the App and
   * has not installed it anywhere yet has nothing registered and wants the
   * picker — `filters.length === 0` would have sent it back to step 0.
   */
  it("sends an empty board to the picker when the App already answers", () => {
    const out = html([], true);

    expect(out).toContain('href="/setup/repository"');
    expect(out).not.toContain("/setup/github-app");
  });

  /**
   * And the other direction: cards can outlive an App's credentials, so a
   * board with projects and no App is step 0 and not the picker, which would
   * only tell it there is no App configured yet.
   */
  it("sends a board with projects to step 0 when there is no App", () => {
    for (const out of [html(["lingtai"], false), html(["lingtai", "esctest"], false)]) {
      expect(out).toContain('href="/setup/github-app"');
      expect(out).not.toContain("/setup/repository");
    }
  });
});

describe("which object on the row this is", () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
  const page = read("../src/app/page.tsx");
  const bar = page.slice(page.indexOf('<div className="bar">'), page.indexOf('<div className="cols">'));

  /**
   * the-bar.md's rule counts four objects on the row, and the filter is one of
   * them — so what this has to show is not that it escaped the count but that
   * it did not add to it. Nothing new opens inside `.rail`, and the `+` is a
   * tab in a list that was already a list of tabs.
   */
  it("is mounted left of the rail, which keeps the four it was cut to", () => {
    expect(bar.indexOf("<Projects")).toBeGreaterThan(-1);
    expect(bar.indexOf("<Projects")).toBeLessThan(bar.indexOf('className="rail"'));
    // Nothing new inside the rail: the reading, the health dot, the
    // paused/draining chip and the headline, as #134 left them.
    const rail = bar.slice(bar.indexOf('className="rail"'));
    for (const object of ["<Projects", "/setup/repository", "/setup/github-app"]) {
      expect(rail).not.toContain(object);
    }
  });

  /**
   * **The four are named in three files, and the way to get this wrong is to
   * make the `+` fit by redefining them.** `page.tsx` says it twice — once in
   * the module's docstring and once in the rule itself, at the end of `.bar` —
   * and the-bar.md is where a later ticket goes to read what it must argue
   * against. If one of them counted the rail instead, the `+` would look like
   * an object outside the rule rather than an affordance of an object inside
   * it, and the next person would get two answers from one render.
   *
   * Line breaks and comment stars are not the claim, so they are collapsed
   * before the membership is read.
   */
  it("leaves the four what they were, in the code and in the doc", () => {
    const said = (src: string) => src.replace(/[\s*]+/g, " ");
    const four = "filter, reading, health, headline";

    // Twice in `page.tsx`: the docstring and the rule it points at.
    expect(said(page).split(four)).toHaveLength(3);
    expect(said(read("../src/app/projects.tsx"))).toContain(four);
    expect(said(read("../../../doc/design/the-bar.md"))).toContain(four);
  });

  /** It is a control in the list, and `.reading` is text for the opposite reason. */
  it("is a tab and not a reading", () => {
    const out = html(["lingtai"], true);

    expect(out).toContain('class="tab add"');
    expect(out).not.toContain("reading");
  });
});
