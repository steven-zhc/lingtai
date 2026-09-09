/**
 * The two rules a repository's label colour has to pass to be drawn.
 *
 * Both are claims about the palette rather than about a function: amber means
 * "a human is the thing being waited on" and nothing else may render in it, and
 * a dot has to be visible on both of this board's grounds — GitHub's colours
 * were chosen against GitHub's light UI, and half of them vanish on ours.
 *
 * The contrast numbers are asserted as contrast, not as hex, so the test says
 * what the rule is rather than what today's arithmetic produced.
 */
import { describe, expect, it } from "vitest";
import { kindDot } from "../src/lib/kind-colour.ts";

/** The two grounds a dot is drawn on: `--surface` light, `--surface` dark. */
const LIGHT = "#ffffff";
const DARK = "#131e22";

function luminance(hex: string): number {
  const channel = (from: number) => {
    const c = Number.parseInt(hex.slice(from, from + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const hi = Math.max(luminance(a), luminance(b));
  const lo = Math.min(luminance(a), luminance(b));
  return (hi + 0.05) / (lo + 0.05);
}

function hue(hex: string): number {
  const at = (from: number) => Number.parseInt(hex.slice(from, from + 2), 16) / 255;
  const [r, g, b] = [at(1), at(3), at(5)];
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  if (max === r) return 60 * (((g - b) / d + 6) % 6);
  if (max === g) return 60 * ((b - r) / d + 2);
  return 60 * ((r - g) / d + 4);
}

describe("a kind's colour", () => {
  /**
   * The criterion in the ticket, and the reason the whole thing reads from
   * GitHub rather than hashing a name: no colour is an answer, and rendering
   * grey text with no dot is what a card did before any of this existed.
   */
  it("is nothing at all when GitHub has none", () => {
    expect(kindDot(null)).toBeNull();
    expect(kindDot(undefined)).toBeNull();
    expect(kindDot("")).toBeNull();
    // Not six hex digits, so not a colour anything can draw. Refused rather
    // than repaired: repairing it means inventing one.
    expect(kindDot("rebeccapurple")).toBeNull();
    expect(kindDot("#abc")).toBeNull();
  });

  /**
   * **The palette's only hard rule.** Amber is "a human is the thing being
   * waited on"; a classification rendering in it would be a taxonomy shouting
   * in the colour reserved for a person being needed, and the collision would
   * be silent — a repository names a label `gold` and it happens to be amber.
   *
   * Refused, not rotated. Rotating would be inventing a hue, which is the thing
   * this design exists to avoid; the kind renders as grey text instead.
   */
  it("is refused when the repository's colour is the amber that means a person is needed", () => {
    // `--signal`, both themes: hue 33.
    expect(kindDot("#9c5a08")).toBeNull();
    expect(kindDot("#e0a55c")).toBeNull();
    // GitHub's own `#fbca04` — the default on `wontfix` and `question`.
    expect(kindDot("#fbca04")).toBeNull();
    expect(kindDot("#ff6600")).toBeNull();
  });

  /**
   * A grey is not amber to anybody looking at it, whatever its nominal hue is,
   * so refusing it would cost a legible dot and protect nothing.
   */
  it("does not refuse a grey for having a nominally amber hue", () => {
    expect(kindDot("#8a8683")).not.toBeNull();
  });

  /**
   * The contrast floor. 3:1 is the threshold for a small non-text mark, and it
   * has to hold on *both* grounds at once — one dot is drawn in both themes.
   */
  it("clears 3:1 on both themes, however pale or dark GitHub's colour is", () => {
    for (const label of [
      "#a2eeef", // GitHub's `help wanted` pale cyan: invisible on the dark theme
      "#ffffff",
      "#000000",
      "#0e1a4a", // near-black navy: invisible on the light theme
      "#d73a4a", // GitHub's default `bug`
      "#0075ca", // GitHub's default `documentation`
      "#7057ff",
      "#008672",
    ]) {
      const dot = kindDot(label);
      expect(dot, `${label} is drawable`).not.toBeNull();
      expect(contrast(dot as string, LIGHT), `${label} on the light theme`).toBeGreaterThanOrEqual(3);
      expect(contrast(dot as string, DARK), `${label} on the dark theme`).toBeGreaterThanOrEqual(3);
    }
  });

  /**
   * Only the lightness moves. The hue and the saturation are the repository's
   * choice and Lingtai does not get a vote on them — a `bug` that GitHub says
   * is red comes out red, merely legible.
   */
  it("keeps the repository's hue when it has to move a colour", () => {
    const pale = kindDot("#a2eeef") as string;
    expect(pale).not.toBe("#a2eeef");
    expect(Math.abs(hue(pale) - hue("#a2eeef"))).toBeLessThan(2);
  });

  /** A colour already inside the band is passed through untouched. */
  it("leaves a colour that is already legible exactly as GitHub sent it", () => {
    expect(kindDot("#0075ca")).toBe("#0075ca");
  });
});
