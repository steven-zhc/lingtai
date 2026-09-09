/**
 * The one place a terminal colour is chosen.
 *
 * There was no such place until #107: not one escape code existed in the tree,
 * so `doctor`'s two failures and its twenty-four passes were the same thirty
 * lines of undifferentiated text, and a refusal, a repair, a routine pass and a
 * shutdown all read alike coming out of the daemon.
 *
 * ## It is the board's vocabulary, not a second one
 *
 * The board's palette already assigns the meanings, and they are quoted here
 * rather than re-derived — `apps/board/src/app/globals.css:1`:
 *
 * > Instrument palette: cool neutrals, one teal accent for structure, amber
 * > reserved exclusively for "a human is the thing being waited on". Semantic
 * > pass/fail/held are separate from the accent so a verdict never reads as
 * > decoration.
 *
 * Two surfaces that colour the same fact differently is worse than one surface
 * with no colour at all, because then an operator has to learn two vocabularies
 * for one system. `test/colour.test.ts` reads that stylesheet and fails if the
 * sentence moves or if a custom property named below stops existing — which is
 * what makes "the two cannot drift apart" a check rather than a hope.
 *
 * ## Semantics, never syntax
 *
 * No rainbow timestamps and no coloured ids. What gets a colour is what the
 * palette already gives a meaning to: a verdict, a state, and the one thing
 * amber is for. **Dim** does more work than colour for ids and clocks.
 *
 * ## Fifteen lines rather than a dependency
 *
 * Deliberately the opposite call from #106, and the difference is the input: a
 * markdown renderer parses untrusted text and a hand-rolled one is a security
 * bug waiting to happen, while an escape code is a constant.
 */

/** `ESC`, spelled rather than typed, so no source file holds a control byte. */
const ESC = "\u001b";

/**
 * Whether anything written to stdout may carry an escape code.
 *
 * Three names, none of which begins `LINGTAI_` — the house rule (#63), broken
 * exactly here and only here. These are the *terminal's* names, not Lingtai's,
 * and an operator who exported `NO_COLOR` for the machine meant it for this
 * program too; a `LINGTAI_NO_COLOR` would be a way of not honouring what they
 * asked for.
 *
 * `NO_COLOR` wins outright, ahead of `FORCE_COLOR`. The two are not symmetric:
 * `FORCE_COLOR`'s job is to defeat the *pipe* check for the person who wants
 * colour through `less -R` anyway, not to overrule an operator's opt-out.
 *
 * Read on every call rather than latched at import, so that a test can set the
 * environment and a daemon that lives for days is never stale about it.
 */
export function coloured(stream: { isTTY?: boolean } = process.stdout): boolean {
  if ((process.env["NO_COLOR"] ?? "") !== "") return false;
  // A terminal that says it cannot is believed ahead of anything saying it can.
  if (process.env["TERM"] === "dumb") return false;
  const forced = process.env["FORCE_COLOR"] ?? "";
  if (forced !== "") return forced !== "0";
  // Output gets piped to files and read with `tail` and `grep`, and a log full
  // of `\x1b[31m` is a log nobody can grep.
  return stream.isTTY === true;
}

/** SGR: opened with the codes given, closed with a full reset. */
function ink(...codes: readonly number[]): (text: string) => string {
  const open = `${ESC}[${codes.join(";")}m`;
  return (text: string) => (coloured() ? `${open}${text}${ESC}[0m` : text);
}

/** The identity, for a fact the palette gives no meaning to. Most facts. */
export const plain = (text: string): string => text;

/**
 * The assignments, one per meaning the board's palette names.
 *
 * | meaning | board | here |
 * |---|---|---|
 * | a verdict passed | `--pass` | green |
 * | a verdict failed | `--fail` | bold red |
 * | a human is being waited on | `--signal` | yellow — **and nothing else** |
 * | held by a person | `--held` | magenta |
 * | structure, ids, chrome | `--accent` / `--muted` | cyan / dim |
 *
 * `fail` is the one that is bold as well as coloured, so that two failures in
 * thirty lines are the two lines you see first. Nothing else is bold: if a
 * second thing were, neither would be.
 */
export const paint = {
  /** A verdict passed — the board's `--pass`, and its Landed lane. */
  pass: ink(32),
  /** A verdict failed — the board's `--fail`. The loudest thing here. */
  fail: ink(1, 31),
  /**
   * A human is the thing being waited on — the board's `--signal`, and its
   * Waiting lane. **Nothing else may use this**, on either surface: the moment
   * amber means two things it means neither.
   */
  signal: ink(33),
  /** Held by a person, or by a run that produced nothing — `--held`. */
  held: ink(35),
  /** Structure: a running thing, a heading, a name — `--accent`. */
  accent: ink(36),
  /** Ids, ticks and clocks — `--muted`. Dim does more work here than colour. */
  muted: ink(2),
} as const;

/**
 * A task's state, in the colour its lane wears on the board.
 *
 * The cases are `LABEL_STATES` from `@lingtai/domain`, spelled out rather than
 * imported because this package has no Lingtai dependencies and should not grow
 * one to hold five strings; the test asserts the two lists still agree. A state
 * with no case keeps the terminal's own colour, which is the answer the board
 * gives a card it has nothing to say about — every stripe coloured is the same
 * as none.
 */
export function stateInk(state: string): (text: string) => string {
  switch (state) {
    // `--pass`: the board's Landed lane.
    case "landed":
      return paint.pass;
    // `--accent`: the board's `a-run`. `gates` folds into it here exactly as it
    // does in the listing — from an operator's seat they are the same fact.
    case "running":
    case "gates":
      return paint.accent;
    // `--signal`: the board's `a-sig`, and the only state that is a person.
    case "waiting":
      return paint.signal;
    default:
      return plain;
  }
}
