/**
 * A repository that is on its way in, on a board that still works (#163).
 *
 * The wizard ends at a pull request and the recipe lands minutes or days later.
 * In between, the project is on the log and has no recipe — and the Queued
 * column's whole job is to ask GitHub, under a recipe, what a project is
 * offering. Asked about this one it would refuse, and a refusal there is not
 * quiet: `#76` made it a red line naming the project, precisely so a broken
 * recipe could not be mistaken for a repository with nothing to do.
 *
 * So the two halves below are the two things the ticket says must not break.
 * The first is about who gets asked, which is a fold and is where the failure
 * would actually be. The second is about what a reader sees, which is the
 * markup, for the reason `#101` established — the fold alone could not have
 * caught it.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { emptyProject, type ProjectState } from "@lingtai/domain";
import { type ProjectQueue, queuedCards, splitRegister } from "../src/lib/board.ts";
import { Pending } from "../src/app/pending.tsx";

/** A project the wizard recorded and whose recipe has not landed. */
const ARRIVING: ProjectState = {
  ...emptyProject,
  project: "esctest-arriving",
  owner: "steven-zhc",
  base: "develop",
  version: 1,
  lastSeq: 1n,
};

/** And one `lingtai add` finished — the difference is the hash, and only the hash. */
const LIVE: ProjectState = {
  ...ARRIVING,
  project: "esctest-live",
  base: "main",
  configHash: "h",
  fromSha: "s",
};

describe("the register, split", () => {
  it("puts a project with no recipe on the pending side, with what Recheck needs", () => {
    const { registered, pending } = splitRegister([LIVE, ARRIVING]);

    expect(registered.map((p) => p.project)).toEqual(["esctest-live"]);
    expect(pending).toEqual([
      { project: "esctest-arriving", owner: "steven-zhc", base: "develop" },
    ]);
  });

  /**
   * The one that matters. `askProject` never throws — it answers `unreadable`,
   * and `queuedCards` turns that into a `problem`, which is a red line in the
   * Queued column naming the project. A pending repository put through here
   * would redden the board every render until somebody merged a pull request.
   */
  it("asks GitHub about the live project and nothing at all about the pending one", async () => {
    const asked: string[] = [];
    const ask = async (state: ProjectState): Promise<ProjectQueue> => {
      asked.push(state.project as string);
      return {
        state: "unreadable",
        filter: { project: state.project as string, ok: false, problem: "asked" },
      };
    };

    const { registered, pending } = splitRegister([LIVE, ARRIVING]);
    const queued = await queuedCards(registered, ask);

    expect(asked).toEqual(["esctest-live"]);
    expect(queued.problems.map((p) => p.project)).toEqual(["esctest-live"]);
    // And it is still on the board — withheld from the column, not dropped.
    expect(pending.map((p) => p.project)).toEqual(["esctest-arriving"]);
  });
});

describe("the pending card", () => {
  const html = () => renderToStaticMarkup(<Pending projects={splitRegister([ARRIVING]).pending} />);

  it("names the repository, says it is pending, and offers Recheck", () => {
    const out = html();

    expect(out).toContain("steven-zhc/");
    expect(out).toContain("esctest-arriving");
    expect(out).toContain("pending");
    expect(out).toContain("Recheck");
  });

  /**
   * The button is pressed against a branch, and which branch is the whole of
   * what it does. A card that did not say so would be a control nobody could
   * tell had been pointed at the wrong place.
   */
  it("says which file on which branch it is waiting for", () => {
    const out = html();

    expect(out).toContain(".lingtai/config.yaml");
    expect(out).toContain("develop");
  });

  /** Nothing pending is the ordinary case, and it must cost the board no room. */
  it("draws nothing at all when nothing is on its way in", () => {
    expect(renderToStaticMarkup(<Pending projects={[]} />)).toBe("");
  });
});
