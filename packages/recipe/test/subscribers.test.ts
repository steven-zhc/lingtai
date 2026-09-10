/**
 * `subscribers:`, which is where an extension is declared and the only place
 * one can be ([0037](../../../doc/decisions/0037-an-extension-is-a-command.md)).
 *
 * Two of these are about refusals, and both refusals exist for the same reason:
 * a subscriber that is declared and never fires is invisible. It looks like a
 * quiet week. The schema is the last place that can say so out loud.
 */
import { describe, expect, it } from "vitest";
import { RECIPE_PATH, RecipeInvalidError, resolveRecipe } from "../src/index.ts";

const recipe = (subscribers: string) => `
version: 1
repo:
  base: main
source:
  kinds: [bug]
env:
  required: []
  plantAt: .env.local
runtime:
  agent: claude-code
${subscribers}
`;

const read = (text: string) => async (path: string, ref: string) =>
  ref === "main" && path === RECIPE_PATH ? text : null;

describe("subscribers", () => {
  it("takes a command, the types it wants, and the names it is given", async () => {
    const resolved = await resolveRecipe(
      read(
        recipe(`subscribers:
  - name: telegram
    on: [WorkItemLanded, WorkItemBlocked]
    run: npx @lingtai/telegram
    timeout: 30s
    env: [TELEGRAM_BOT_TOKEN]`),
      ),
      "main",
    );

    const [telegram] = resolved.recipe.subscribers;
    expect(telegram?.name).toBe("telegram");
    expect(telegram?.on).toEqual(["WorkItemLanded", "WorkItemBlocked"]);
    expect(telegram?.run).toBe("npx @lingtai/telegram");
    expect(telegram?.timeout).toBe("30s");
    expect(telegram?.env).toEqual(["TELEGRAM_BOT_TOKEN"]);
  });

  /**
   * Present and empty, like every gate point. A recipe that declares none is a
   * project nothing is told about, which is a fact — not an absence somebody
   * has to know the meaning of (0016 §4).
   */
  it("is empty rather than absent when a recipe says nothing", async () => {
    const resolved = await resolveRecipe(read(recipe("")), "main");
    expect(resolved.recipe.subscribers).toEqual([]);
  });

  it("has a timeout without being given one, because nothing else bounds a hang", async () => {
    const resolved = await resolveRecipe(
      read(
        recipe(`subscribers:
  - name: notify
    on: [WorkItemBlocked]
    run: lingtai-notify`),
      ),
      "main",
    );
    expect(resolved.recipe.subscribers[0]?.timeout).toBe("2m");
    expect(resolved.recipe.subscribers[0]?.env).toEqual([]);
  });

  /**
   * The defect this repository keeps producing, caught at the only moment it
   * can be: a check that is present, reported, and looking at nothing. A
   * subscriber on `WorkItemComplete` would be declared, rendered, and never
   * once started, and no failure anywhere would say so.
   */
  it("refuses a type the log does not have, naming the key", async () => {
    const failed = await resolveRecipe(
      read(
        recipe(`subscribers:
  - name: notify
    on: [WorkItemComplete]
    run: lingtai-notify`),
      ),
      "main",
    ).catch((err: unknown) => err as RecipeInvalidError);

    expect(failed).toBeInstanceOf(RecipeInvalidError);
    expect((failed as RecipeInvalidError).problems.join("\n")).toContain("subscribers.0.on");
  });

  /**
   * `#63`'s prefix, doing the work a denylist used to. The structural half is
   * `extensionEnv`, which never has a `LINGTAI_` value to hand over; this half
   * is what tells the person writing the recipe why nothing arrived.
   */
  it("refuses an extension that asks for one of Lingtai's own variables", async () => {
    const failed = await resolveRecipe(
      read(
        recipe(`subscribers:
  - name: nosy
    on: [WorkItemLanded]
    run: cat
    env: [LINGTAI_DATABASE_URL]`),
      ),
      "main",
    ).catch((err: unknown) => err as RecipeInvalidError);

    expect(failed).toBeInstanceOf(RecipeInvalidError);
    expect((failed as RecipeInvalidError).problems.join("\n")).toMatch(/subscribers\.0\.env/);
  });
});
