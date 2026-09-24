/**
 * What `lingtai add` decides about the base — which, since #75, is nothing.
 *
 * No network and no database: `governing` takes a reader, exactly as
 * `resolveRecipe` does, so the three rows of the table are assertable about the
 * decision itself rather than about a command that also talks to GitHub.
 */
import { RECIPE_PATH, resolveRecipe } from "@lingtai/recipe";
import {
  type Envelope,
  type EventType,
  type PayloadOf,
  SCHEMA_VER,
  parsePayload,
} from "@lingtai/domain";
import { describe, expect, it } from "vitest";
import { type Installation, NotInstalledError } from "@lingtai/github";
import { type AddOptions, governing, recheck, registrationLine, resumeOnboarding } from "../src/onboard.ts";

const recipe = (base: string) => `
version: 2
repo:
  base: ${base}
source:
  kinds: [bug]
env:
  required: []
  plantAt: .env.local
runtime:
  agent: claude-code
`;

const reader = (files: Record<string, string>) => async (path: string, ref: string) =>
  files[`${ref}:${path}`] ?? null;

const SLUG = "steven-zhc/nextloom-ai-admin";

describe("the base lingtai add records", () => {
  it("is the recipe's, when the branch it was read from agrees", async () => {
    const found = await governing(
      reader({ [`develop:${RECIPE_PATH}`]: recipe("develop") }),
      { ref: "develop", named: true },
      SLUG,
    );

    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.resolved.recipe.repo.base).toBe("develop");
    expect(found.adoptedFrom).toBeNull();
  });

  /**
   * The bootstrap. The default branch is only where the file was found; the file
   * says which branch it governs, and the recipe that comes back — and so the
   * hash recorded beside the base — is the one on *that* branch.
   */
  it("is adopted from the recipe when nobody named a branch", async () => {
    const found = await governing(
      reader({
        [`main:${RECIPE_PATH}`]: recipe("develop"),
        [`develop:${RECIPE_PATH}`]: recipe("develop").replace("kinds: [bug]", "kinds: [bug, tech-debt]"),
      }),
      { ref: "main", named: false },
      SLUG,
    );

    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.resolved.recipe.repo.base).toBe("develop");
    expect(found.resolved.ref).toBe("develop");
    expect(found.adoptedFrom).toBe("main");
    // Read again at the branch it governs, not carried over from `main`.
    expect(found.resolved.recipe.source.kinds).toEqual(["bug", "tech-debt"]);
  });

  it("refuses, naming both branches, when a person named one the recipe contradicts", async () => {
    const found = await governing(
      reader({
        [`main:${RECIPE_PATH}`]: recipe("develop"),
        [`develop:${RECIPE_PATH}`]: recipe("develop"),
      }),
      { ref: "main", named: true },
      SLUG,
    );

    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.refusal).toContain("main");
    expect(found.refusal).toContain("develop");
    // And it says which of the two is the decision, rather than picking one.
    expect(found.refusal).toContain("repo.base");
  });

  it("refuses when the branch the recipe names has no recipe on it", async () => {
    const found = await governing(
      reader({ [`main:${RECIPE_PATH}`]: recipe("develop") }),
      { ref: "main", named: false },
      SLUG,
    );

    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.refusal).toContain("main");
    expect(found.refusal).toContain(`no ${RECIPE_PATH} on develop`);
  });

  /** One hop is a bootstrap; two is a recipe disagreeing with the branch it is on. */
  it("refuses rather than following a second hop", async () => {
    const found = await governing(
      reader({
        [`main:${RECIPE_PATH}`]: recipe("develop"),
        [`develop:${RECIPE_PATH}`]: recipe("release"),
        [`release:${RECIPE_PATH}`]: recipe("release"),
      }),
      { ref: "main", named: false },
      SLUG,
    );

    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.refusal).toContain("develop");
    expect(found.refusal).toContain("release");
  });
});

/**
 * The half the board presses, and the half it presses *with* (#163).
 *
 * `Recheck` has no flags on it and never will: what it sends is a base a
 * `ProjectOnboardingStarted` recorded, filled by the wizard from GitHub's
 * default branch. Sent as a typed `--base` the row above — *refuses, naming
 * both branches* — would fire on the ordinary case and keep firing, because the
 * advice it gives is to re-run without a flag nobody typed and a button cannot
 * omit.
 */
describe("finishing an onboarding the wizard recorded", () => {
  it("replays the recorded base as a hint, and not as a flag a person typed", () => {
    expect(resumeOnboarding({ owner: "steven-zhc", project: "nextloom-ai-admin", base: "main" })).toEqual({
      slug: SLUG,
      base: { ref: "main", named: false },
    });
  });

  /**
   * The sequence in full. The wizard recorded `main`; review corrected
   * `repo.base` to `develop` while the recipe PR was open, and the PR merged
   * into `main`. The recipe governs, exactly as it does for `lingtai add` with
   * no flag — and `Recheck` goes through rather than refusing for ever.
   */
  it("adopts the base the recipe declares when review moved it", async () => {
    const options = resumeOnboarding({ owner: "steven-zhc", project: "nextloom-ai-admin", base: "main" });
    const found = await governing(
      reader({
        [`main:${RECIPE_PATH}`]: recipe("develop"),
        [`develop:${RECIPE_PATH}`]: recipe("develop"),
      }),
      options.base!,
      SLUG,
    );

    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.resolved.recipe.repo.base).toBe("develop");
    expect(found.adoptedFrom).toBe("main");
  });
});

/**
 * What `Recheck` asks: GitHub for the installation first, then `add` — and no
 * longer for a recipe landing in the repository (#182). The wizard recorded the
 * project through the installation, but it can have been removed since, and
 * that must be answered in its own sentence with nothing written; so must a
 * refusal from `add` of an installation that is there.
 */
describe("Recheck", () => {
  const RECORDED = { owner: "steven-zhc", project: "nextloom-ai-admin", base: "main" };
  const INSTALLED: Installation = {
    id: 7,
    permissions: {},
    account: "steven-zhc",
    repositorySelection: "selected",
    htmlUrl: null,
  };

  it("asks GitHub about the installation and registers nothing while the App is not installed", async () => {
    const asked: string[] = [];
    const registered: AddOptions[] = [];
    const result = await recheck(RECORDED, {
      installation: async (owner, repo) => {
        asked.push(`${owner}/${repo}`);
        throw new NotInstalledError(owner, repo);
      },
      register: async (options) => {
        registered.push(options);
        return 0;
      },
    });

    expect(asked).toEqual([SLUG]);
    expect(registered).toEqual([]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.installed).toBe(false);
    expect(result.detail).toContain(`not installed on ${SLUG}`);
    expect(result.detail).toContain("press Recheck");
    expect(result.detail).not.toContain("lingtai add");
  });

  it("registers through add, with the recorded base as a hint and the installation it read", async () => {
    const registered: AddOptions[] = [];
    const result = await recheck(RECORDED, {
      installation: async () => INSTALLED,
      register: async (options, log) => {
        registered.push(options);
        log("recipe: ~/.lingtai/nextloom-ai-admin/recipe.yml");
        return 0;
      },
    });

    expect(registered).toEqual([{ ...resumeOnboarding(RECORDED), installation: INSTALLED }]);
    expect(result).toEqual({ ok: true, detail: "nextloom-ai-admin is live" });
  });

  it("hands back everything add said when it refuses an installed repository", async () => {
    const result = await recheck(RECORDED, {
      installation: async () => INSTALLED,
      register: async (_options, log) => {
        log("the installation is missing permissions:");
        log("  issues: have read, need write — reading work items");
        return 1;
      },
    });

    expect(result).toEqual({
      ok: false,
      installed: true,
      detail: "the installation is missing permissions:\n  issues: have read, need write — reading work items",
    });
  });

  it("does not read any other failure as not installed", async () => {
    await expect(
      recheck(RECORDED, {
        installation: async () => {
          throw new Error("502 on /repos/steven-zhc/nextloom-ai-admin/installation: Bad Gateway");
        },
        register: async () => 0,
      }),
    ).rejects.toThrow("502");
  });
});

let seq = 1n;

/** One stream's envelopes, versioned in call order. Payloads go through zod. */
function stream(streamId: string) {
  let version = 0;
  return function event<T extends EventType>(type: T, data: PayloadOf<T>): Envelope {
    version += 1;
    return {
      seq: seq++,
      streamId,
      version,
      type,
      schemaVer: SCHEMA_VER[type],
      data: parsePayload(type, data),
      actor: "conductor",
      causation: null,
      at: new Date("2026-09-15T12:00:00.000Z"),
    };
  };
}

/**
 * What the command says it did — which is about the *project*, not the stream.
 *
 * A wizard-onboarded repository arrives here with one event already on it, so
 * counting events reports the first registration any of them ever had as an
 * update, and the tier-and-gates summary onboarding exists to print is never
 * printed for one (#163).
 */
describe("the last line lingtai add prints", () => {
  const resolved = () => resolveRecipe(reader({ [`develop:${RECIPE_PATH}`]: recipe("develop") }), "develop");
  const event = stream("prj-nextloom-ai-admin");
  const started = event("ProjectOnboardingStarted", {
    slug: SLUG,
    base: "main",
    by: "human:steven",
  });
  const configured = event("ProjectConfigured", {
    project: "nextloom-ai-admin",
    owner: "steven-zhc",
    base: "develop",
    configHash: "h",
    fromSha: "s",
  });

  it("says added when the only earlier event is the wizard's", async () => {
    const line = registrationLine([started], "nextloom-ai-admin", await resolved());

    expect(line).toContain("added nextloom-ai-admin");
    expect(line).toContain("tier ");
    expect(line).toContain("across 5 gates");
    expect(line).not.toContain("updated");
  });

  it("says updated only once the project has been configured before", async () => {
    const line = registrationLine([started, configured], "nextloom-ai-admin", await resolved());

    expect(line).toContain("updated nextloom-ai-admin");
    expect(line).toContain("2 earlier event(s)");
  });

  it("says added on a stream with nothing on it at all", async () => {
    expect(registrationLine([], "nextloom-ai-admin", await resolved())).toContain("added");
  });
});
