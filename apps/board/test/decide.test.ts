/**
 * #150: no call site on the board can name a gate.
 *
 * The board's Waive took a gate from its caller, and the two callers disagreed:
 * `standing.tsx` passed the run's real names, and `page.tsx` passed the literal
 * `["build"]` — so a waived `review` was recorded on the home board as a waived
 * `build`. The fix is not a better literal. The waivers are what `approve()`
 * appends, from `refusingGates` over the run it has just read, so there is no
 * argument left for a caller to get wrong; `run-once.test.ts` pins which gates
 * those are.
 *
 * This pins the other half: that nothing on the board has grown one back. A
 * source read rather than a render, because the defect was an argument, and an
 * argument that is never rendered is exactly what a render cannot see.
 */
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFile(new URL(`../src/${path}`, import.meta.url), "utf8");
const CALLERS = ["app/actions.ts", "app/decide.tsx", "app/page.tsx", "app/standing.tsx"];

describe("the card's decisions", () => {
  it("has no call site that names a gate, and nothing that waives or rejects on its own", async () => {
    for (const path of CALLERS) {
      const text = await source(path);
      // Code, not prose: the comments that explain why these are gone may say so.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(code, path).not.toMatch(/\bwaive\s*\(/);
      expect(code, path).not.toMatch(/\bwaiveGate\b/);
      expect(code, path).not.toMatch(/\breject(Card)?\s*\(/);
      expect(code, path).not.toMatch(/\bgates=\{/);
      expect(code, path).not.toMatch(/\bgate:\s*["'`]/);
    }
  });

  it("sends Approve no gate — only the sha, and the reason", async () => {
    const actions = await source("app/actions.ts");
    const approveCard = actions.slice(actions.indexOf("export async function approveCard"), actions.indexOf("export async function requeueCard"));
    expect(approveCard).toContain("onSha: input.onSha");
    expect(approveCard).toContain("note: input.note");
    expect(approveCard).not.toMatch(/\bgates?\b\s*[:=]/);
  });
});
