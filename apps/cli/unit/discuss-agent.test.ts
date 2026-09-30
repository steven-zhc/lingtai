/**
 * `@lingtai/recipe`'s `DiscussAgent` against `@lingtai/agent`'s own table —
 * the two halves of `#243`'s enum that cannot be one import.
 *
 * `packages/recipe` depends on `@lingtai/domain`, `@lingtai/env`, `picomatch`
 * and `yaml`, and must not gain a dependency on every runtime adapter to name
 * three letters — so `DiscussAgent` is written out by hand there, and this is
 * what keeps it from drifting: it constructs every `RuntimeId` with
 * `tools: "none"` and asserts that the ones which do not throw
 * `ToolsCannotBeDenied` are exactly `DiscussAgent`'s options. A runtime that
 * gains the ability to be given no tools is a failure here, not a schema
 * `recipe.ts` forgot to widen.
 */
import { describe, expect, it } from "vitest";
import { RuntimeId } from "@lingtai/domain";
import { createRuntime, ToolsCannotBeDenied } from "@lingtai/agent";
import { DiscussAgent } from "@lingtai/recipe";

describe("DiscussAgent", () => {
  it("names exactly the runtimes that can be held to tools: none", () => {
    const toolless = RuntimeId.options.filter((id) => {
      try {
        createRuntime(id, { tools: "none" });
        return true;
      } catch (err) {
        if (err instanceof ToolsCannotBeDenied) return false;
        throw err;
      }
    });
    expect([...DiscussAgent.options].sort()).toEqual(toolless.sort());
  });
});
