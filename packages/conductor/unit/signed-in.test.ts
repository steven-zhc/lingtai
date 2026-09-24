/**
 * Which runtimes are signed in here (0046 §3, #180) — the real detector's
 * shape, with the probes faked and the clock a number.
 *
 * `local.test.ts` injects `signedIn` directly, so it cannot see whether the
 * detector a run actually uses can ever say *two*. This does.
 */
import { describe, expect, it } from "vitest";
import { AgentUnresolvedError, recipePath, resolveLocalRecipe } from "@lingtai/recipe";
import { CLAUDE_CODE_CAPABILITIES, CODEX_CAPABILITIES } from "@lingtai/agent";
import { signedInProbe } from "../src/projects.ts";

function probe(capabilities: typeof CLAUDE_CODE_CAPABILITIES, loggedIn: () => boolean) {
  const asked = { n: 0 };
  return {
    asked,
    runtime: {
      capabilities,
      checkAuth: async () => {
        asked.n += 1;
        return { loggedIn: loggedIn(), method: null, detail: "" };
      },
    },
  };
}

const HOME = "/home/me/.lingtai";
const RECIPE = `
version: 2
repo: { base: main }
source: { kinds: [bug] }
env: { plantAt: .env.local }
steps: {}
`;

describe("signedInProbe", () => {
  it("asks codex as well as claude-code, so a machine signed in to both is asked which", async () => {
    const claude = probe(CLAUDE_CODE_CAPABILITIES, () => true);
    const codex = probe(CODEX_CAPABILITIES, () => true);
    const signedIn = signedInProbe([claude.runtime, codex.runtime]);

    expect(await signedIn()).toEqual(["claude-code", "codex"]);
    await expect(
      resolveLocalRecipe("app", {
        home: HOME,
        signedIn,
        read: async (path) => (path === recipePath("app", HOME) ? RECIPE : null),
      }),
    ).rejects.toThrow(AgentUnresolvedError);
  });

  it("remembers an empty answer, so a render does not start a process per project", async () => {
    let clock = 0;
    const claude = probe(CLAUDE_CODE_CAPABILITIES, () => false);
    const codex = probe(CODEX_CAPABILITIES, () => false);
    const signedIn = signedInProbe([claude.runtime, codex.runtime], 60_000, () => clock);

    for (let i = 0; i < 5; i++) expect(await signedIn()).toEqual([]);
    expect(claude.asked.n).toBe(1);
    expect(codex.asked.n).toBe(1);

    clock = 60_000;
    await signedIn();
    expect(claude.asked.n).toBe(2);
  });

  it("sees a sign-in once the answer has aged out", async () => {
    let clock = 0;
    let signed = false;
    const claude = probe(CLAUDE_CODE_CAPABILITIES, () => signed);
    const signedIn = signedInProbe([claude.runtime], 60_000, () => clock);

    expect(await signedIn()).toEqual([]);
    signed = true;
    clock = 60_001;
    expect(await signedIn()).toEqual(["claude-code"]);
  });
});
