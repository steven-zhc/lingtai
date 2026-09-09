/**
 * Two things, and the second is the point of the module.
 *
 * The first is the ordinary one: `NO_COLOR`, `FORCE_COLOR` and the TTY check,
 * because a log full of `\x1b[31m` is a log nobody can grep and an operator who
 * exported `NO_COLOR` meant it.
 *
 * The second reads `apps/board/src/app/globals.css` and fails if the board's
 * palette moves out from under the terminal's copy of it. Two surfaces that
 * colour the same fact differently is worse than one surface with no colour at
 * all, and a comment saying so would not have noticed. This does.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { coloured, paint, plain, stateInk } from "../src/colour.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const GLOBALS = resolve(root, "apps/board/src/app/globals.css");

/** The environment is process-wide; every case here puts back what it moved. */
const KEYS = ["NO_COLOR", "FORCE_COLOR", "TERM"] as const;
const before = new Map(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const [k, v] of before) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Whatever the machine running the suite has, none of it decides these cases. */
function clear(): void {
  for (const k of KEYS) delete process.env[k];
}

describe("when a terminal may be coloured", () => {
  it("says nothing in escape codes when stdout is not a TTY", () => {
    clear();
    expect(coloured({ isTTY: false })).toBe(false);
    expect(coloured({})).toBe(false);
  });

  it("colours a TTY", () => {
    clear();
    expect(coloured({ isTTY: true })).toBe(true);
  });

  /** The standard. Any value at all, including `0`, means the operator opted out. */
  it("respects NO_COLOR whatever it is set to", () => {
    clear();
    process.env["NO_COLOR"] = "1";
    expect(coloured({ isTTY: true })).toBe(false);
    process.env["NO_COLOR"] = "0";
    expect(coloured({ isTTY: true })).toBe(false);
  });

  /** Empty is not set, or exporting it blank in a profile would disable colour. */
  it("treats an empty NO_COLOR as absent", () => {
    clear();
    process.env["NO_COLOR"] = "";
    expect(coloured({ isTTY: true })).toBe(true);
  });

  it("lets FORCE_COLOR through a pipe, and FORCE_COLOR=0 turn colour off", () => {
    clear();
    process.env["FORCE_COLOR"] = "1";
    expect(coloured({ isTTY: false })).toBe(true);
    process.env["FORCE_COLOR"] = "0";
    expect(coloured({ isTTY: true })).toBe(false);
  });

  /**
   * The asymmetry, stated as a test because it is a decision rather than an
   * oversight: `FORCE_COLOR`'s job is to defeat the *pipe* check, not to
   * overrule somebody who asked for no colour at all.
   */
  it("does not let FORCE_COLOR overrule NO_COLOR", () => {
    clear();
    process.env["NO_COLOR"] = "1";
    process.env["FORCE_COLOR"] = "1";
    expect(coloured({ isTTY: true })).toBe(false);
  });

  it("believes a terminal that says it is dumb", () => {
    clear();
    process.env["TERM"] = "dumb";
    expect(coloured({ isTTY: true })).toBe(false);
  });
});

describe("what a paint does", () => {
  it("returns the text untouched when colour is off", () => {
    clear();
    for (const ink of Object.values(paint)) expect(ink("hello")).toBe("hello");
    expect(plain("hello")).toBe("hello");
  });

  it("wraps and closes when colour is on", () => {
    clear();
    process.env["FORCE_COLOR"] = "1";
    expect(paint.pass("ok")).toBe("\u001b[32mok\u001b[0m");
    // The only bold one, so that two failures in thirty lines are the two lines
    // you see first.
    expect(paint.fail("FAIL")).toBe("\u001b[1;31mFAIL\u001b[0m");
    expect(paint.signal("waiting")).toBe("\u001b[33mwaiting\u001b[0m");
    expect(paint.held("paused")).toBe("\u001b[35mpaused\u001b[0m");
    expect(paint.accent("running")).toBe("\u001b[36mrunning\u001b[0m");
    expect(paint.muted("1692/1692")).toBe("\u001b[2m1692/1692\u001b[0m");
  });

  it("gives each meaning its own rendering, so no two facts read alike", () => {
    clear();
    process.env["FORCE_COLOR"] = "1";
    const rendered = Object.values(paint).map((ink) => ink("x"));
    expect(new Set(rendered).size).toBe(rendered.length);
  });
});

describe("a state wears the colour of its lane on the board", () => {
  /** `LABEL_STATES`, in `packages/domain/src/streams.ts`. */
  const LABEL_STATES = ["queued", "running", "gates", "waiting", "landed"];

  it("still knows every state the domain has", () => {
    const declared = readFileSync(resolve(root, "packages/domain/src/streams.ts"), "utf8");
    const listed = /export const LABEL_STATES = \[([^\]]*)\]/.exec(declared)?.[1] ?? "";
    const names = [...listed.matchAll(/"([a-z]+)"/g)].map((m) => m[1] ?? "");
    // If a sixth state lands, this fails and somebody decides what colour it
    // is — rather than it quietly rendering as the terminal's default forever.
    expect(names).toEqual(LABEL_STATES);
  });

  it("matches page.tsx's stripe, lane for lane", () => {
    clear();
    process.env["FORCE_COLOR"] = "1";
    // `a-pass`, `a-run`, `a-sig` in `apps/board/src/app/page.tsx`.
    expect(stateInk("landed")("x")).toBe(paint.pass("x"));
    expect(stateInk("running")("x")).toBe(paint.accent("x"));
    expect(stateInk("gates")("x")).toBe(paint.accent("x"));
    expect(stateInk("waiting")("x")).toBe(paint.signal("x"));
    // The board gives a plain queued card the neutral rule, not a colour.
    expect(stateInk("queued")).toBe(plain);
    expect(stateInk("something-new")).toBe(plain);
  });
});

describe("the terminal and the board cannot drift apart quietly", () => {
  const css = readFileSync(GLOBALS, "utf8");

  /**
   * The sentence quoted in `colour.ts`'s header. If somebody rewrites the
   * palette's reasoning, this fails and they have to come and say whether the
   * terminal's copy still holds.
   */
  it("still says what colour.ts quotes it as saying", () => {
    const said = css.replace(/\s+/g, " ");
    expect(said).toContain("cool neutrals, one teal accent for structure");
    expect(said).toContain('amber reserved exclusively for "a human is the thing being waited on"');
    expect(said).toContain(
      "Semantic pass/fail/held are separate from the accent so a verdict never reads as decoration",
    );
  });

  /** Every meaning this module claims still exists as a custom property there. */
  it("still defines every custom property the assignments name", () => {
    for (const name of ["--pass", "--fail", "--signal", "--held", "--accent", "--muted"]) {
      expect(css).toContain(`${name}:`);
    }
  });
});
