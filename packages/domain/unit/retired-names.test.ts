/**
 * **One glossary of retired names, and a list that may only shrink** (`#232`).
 *
 * The pipeline epic renames the vocabulary over several tickets, and a rename
 * spread over several tickets ends as two vocabularies for one thing — which is
 * the defect [0058](../../../doc/decisions/0058-lingtai-is-a-development-pipeline.md)
 * §Context was written about. Before this file nothing could tell whether a
 * name in `src/` was current or left over.
 *
 * **The lists are read from `doc/reference.md`, not copied here** — the same
 * rule `doc/tamper-watch.md` and `packages/actions/unit/tamper-watch.test.ts`
 * follow, and 0059 §5's *the document cannot drift from the code without a red
 * test* a third time. There is one home for the words, one home for the
 * exemptions and one home for the allowlist, and it is that document. **There is
 * no copy of the debt in this file**, which is a decision and is argued for in
 * that section: this epic renames files, so a baseline keyed by path reads a
 * file that moved as a widening that did not happen, and sends the author to
 * hand-edit the one table whose edits are supposed to be expensive.
 *
 * **Reading a list from the document is not the same as letting the document
 * decide it.** The four words are pinned here, and so are the two exemptions and
 * the two glued tokens, because each of those rows makes a retired name green or
 * red without moving a count while it does it: a word taken off the list stops
 * being matched, an exemption skips the match outright, everywhere, and a glued
 * row taken out takes its counts with it. What the document decides on
 * its own is the allowlist — the one table whose every row is checked against
 * `src/`, and whose size is checked against the sentence above it.
 *
 * **The ledger counts occurrences, and that is the half a set cannot do.** Keyed
 * by distinct `file · token` — which is what this shipped as — a name already
 * recorded in a file already listed is recorded, however many more times it
 * arrives: `export const gate = "…the gate failed"` appended to `run-once.ts`,
 * a new identifier and a new operator-facing string, moves nothing and lands
 * green. Every file the epic is going to touch already says `gate` or `point`
 * once, so that hole is exactly the shape of the epic. A count closes it, and
 * closes it in both directions at once — a use deleted is as red as a use
 * added, which is the same equality that makes a stale row red.
 *
 * **This ticket renames nothing.** It records what is still wrong and makes it
 * countable: every violation is counted in a row, and **a count with nothing
 * behind it is as red as one that is short**. So a ticket that renames its area
 * deletes its rows and corrects one number, and a ticket that would widen the
 * debt cannot do it out of sight — the use needs a count, and the count makes
 * that number wrong until it is raised, on a line that says what it is counting.
 * Whether it should have been raised is a reading, and belongs to the review
 * rather than to this file.
 *
 * **Whole words inside a token, never substrings.** `checkpoint` (55),
 * `checkpoints` (34), `pointer` (17) and `pointed` (29) occurrences of the
 * source text, as `#232` counted them on 2026-09-22, are the projector's and
 * the installer's own vocabulary and have
 * nothing to do with a step; a substring ban on `point` — a grep, which is what
 * anybody reaches for first — destroys all four. *does not reach inside a word*
 * below is the test that says so, and it is the reason the document holds a list
 * of words rather than a regex.
 *
 * **And two tokens are listed because that rule cannot see them.** `sgate` and
 * `actpoint` are the retired concept behind a prefix — the board's class
 * vocabulary, in its JSX and in its stylesheet — and `words("sgate")` is
 * `["sgate"]`, on no list. They are matched by token, which is a door that only
 * ever adds violations: *matches two tokens the words are glued into* pins the
 * pair, and *does not reach inside a word* is what keeps `checkpoint` off it.
 *
 * Two of the four are also names the **rule** reads in quantity — on 2026-09-23,
 * `checkpoint` 9 times in 7 files and `checkpoints` 22 in 5 — and a case asserts
 * that they are read *at all*, because a guard that asserts a live subject over
 * text the rule never sees asserts nothing. The numbers are a measurement and
 * not what is held: pinning them would red the gate on any diff that adds a
 * checkpoint. The other two are **not** asserted live, and that is deliberate:
 * `pointer`'s 17 occurrences are all comments, which the rule never reads, and
 * `pointed`'s reads are all the one local `install.ts:465` declares. **An
 * assertion resting on a single local is a red `build` gate the day somebody
 * renames it**, on a diff that introduces no retired name and with no action in
 * the failure a reader could take — `cursor: "pointer"` added to a component is
 * the same trap from the other side. What holds for all four, live or not, is
 * that the rule does not flag them, and that is what is asserted over everything
 * `src/` hands over.
 */
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));

/** `GatesResolved` → `gates` · `resolved`; `checkpoint` → `checkpoint`, one word and safe. */
function words(token: string): string[] {
  return (token.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g) ?? []).map((w) => w.toLowerCase());
}

/**
 * What the rule reads: every identifier, and the text of every string, template
 * chunk and piece of JSX copy — **parsed by `typescript`, not scanned by hand.**
 *
 * The first version of this was a hand-written lexer and it got `.tsx` wrong in
 * both directions at once. The `/` of a `</p>` read as the opening of a regex
 * literal, so everything up to the next `/` anywhere in the file was discarded:
 * `apps/board/src/app/plan.tsx` came back as 889 characters of its 4144 and so
 * carried no row here, though `point` and `points` are all over it, and a new
 * retired name dropped into a swallowed span was green. And a span swallowed
 * that way took the `//` or `/*` that opens a comment with it, so the prose
 * after one was counted as code — five files carried rows that only their
 * comments say. A `.tsx` lexer is not a thing to keep guessing at against a
 * board somebody else is writing, and the compiler this repository is built
 * with already has one.
 *
 * Comments come out, because **nothing mechanical can tell a comment about the
 * past from a comment about the present** — 0018's *the point called `diff`* is
 * correct and must keep its word. `forEachChild` does not descend into a
 * comment or a JSDoc block, and *reads no comment* below is the case for it.
 *
 * What is left is the code (identifiers, types, event types, recipe keys) and
 * the strings and JSX a person reads: the board's copy, a refusal's text,
 * `lingtai`'s output. A regex literal's body is none of those and is not read.
 */
const READ_AS_TEXT: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.JsxText,
]);

function scannable(src: string, name: string): string {
  // **The script kind follows the extension, and it is not a formality.** Under
  // `TSX` a `<T>(x: T) => x` in a `.ts` file is read as an element and the code
  // after it as JSX children, which turns the comments below it into text the
  // rule reads: parsing `packages/recipe/src/propose.ts` that way invented a
  // `gate` that only its JSDoc says.
  const kind = name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const parsed = ts.createSourceFile(name, src, ts.ScriptTarget.Latest, false, kind);
  const read: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) read.push(node.text);
    else if (READ_AS_TEXT.has(node.kind)) read.push((node as ts.LiteralLikeNode).text);
    node.forEachChild(visit);
  };
  parsed.forEachChild(visit);
  // One token per line, so that `` `review${n}gates` `` never reads as one.
  return read.join("\n");
}

/**
 * **A stylesheet's class selectors, and nothing under them.** A `.tsx` writing
 * `className="point"` and a `globals.css` writing `.point` are one word in two
 * files, and a rule that read only the first would let `#233` empty the ledger
 * over a stylesheet that still says it — with the class now matching nothing,
 * which is the two-vocabularies defect and a dead rule at once.
 *
 * A declaration is not read, for the reason a comment is not: `cursor: pointer`
 * and `1080px` are a language nobody here renames, and what the board shares
 * with its components is the selector. And a comment goes the way it goes in a
 * `.ts`: 21 of `globals.css`'s 176 comment blocks say `gate` or `point` while
 * explaining why a rule is there, and every one keeps the word it happened
 * under.
 */
function classes(src: string): string[] {
  return (src.replace(/\/\*[\s\S]*?\*\//g, " ").match(/\.[A-Za-z_-][A-Za-z0-9_-]*/g) ?? []).map((c) => c.slice(1));
}

/** Every identifier-shaped token the rule reads out of one file, in order. */
function tokens(src: string, name: string): string[] {
  if (name.endsWith(".css")) return classes(src);
  return scannable(src, name).match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
}

/**
 * The extensions the rule reads, which is **the boundary inside `src/`** and is
 * stated in the document beside the other three. `.prisma` and the `.json` beside
 * it are generated from a schema and renamed with it; nothing else is here.
 */
const READS = /\.(tsx?|css)$/;

/** Every file under `{apps,packages}/*<!---->/src/`, whatever the rule makes of it. */
async function everything(): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await walk(path);
      else found.push(path.slice(root.length));
    }
  };
  for (const parent of ["apps", "packages"]) {
    for (const name of (await readdir(`${root}${parent}`)).sort()) {
      await walk(`${root}${parent}/${name}/src`).catch(() => {});
    }
  }
  return found.sort();
}

/** Those of them the rule reads, and nothing under `doc/`. */
async function sources(): Promise<string[]> {
  return (await everything()).filter((file) => READS.test(file));
}

/** file → token → how many times the rule reads it there. */
type Counted = ReadonlyMap<string, ReadonlyMap<string, number>>;

/**
 * One markdown document's `## retired name` section, subsection by subsection.
 *
 * **It takes the text rather than reading the file**, so that *the ledger* below
 * can hand it a section it wrote — a row added, a count raised, a file moved, an
 * empty table — and assert what each one does. A rule asserted only against
 * today's document is a rule asserted only where it already holds.
 */
function parse(doc: string) {
  const start = doc.indexOf("\n## retired name");
  expect(start, "doc/reference.md has no `## retired name` section — the glossary has no home").toBeGreaterThan(0);
  const body = doc.slice(start + 1);
  // `-1` is the section running to the end of the file, which is what `#233`
  // leaves behind if it deletes what follows it rather than what it is for.
  const ends = body.indexOf("\n## ", 1);
  const section = ends === -1 ? body : body.slice(0, ends);

  /** The `|`-rows of one `###` subsection, header and separator dropped. */
  const rows = (subheading: string): string[][] => {
    const at = section.indexOf(`### ${subheading}`);
    expect(at, `doc/reference.md's retired-name section has no "### ${subheading}"`).toBeGreaterThan(0);
    const rest = section.slice(at);
    const until = rest.indexOf("\n### ", 1);
    return (until === -1 ? rest : rest.slice(0, until))
      .split("\n")
      .filter((line) => line.trimStart().startsWith("|"))
      .map((line) =>
        line
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((cell) => cell.trim().replace(/^`|`$/g, "")),
      )
      .filter((cells) => !/^-+$/.test(cells[0]!) && cells[0] !== "retired" && cells[0] !== "token" && cells[0] !== "file");
  };

  /** `` `gate` ×12 · `gates` ×3 `` — the count is the entry, so a cell without one is a broken row. */
  const counts = (cell: string): Map<string, number> => {
    const read = new Map<string, number>();
    for (const piece of cell.split("·")) {
      const said = /^(\S+)\s*×\s*(\d+)$/.exec(piece.trim().replace(/`/g, ""));
      expect(said, `doc/reference.md's allowlist has "${piece.trim()}", which says no count`).not.toBeNull();
      read.set(said![1]!, Number(said![2]));
    }
    return read;
  };

  const glossaryRows = rows("the words");
  // The allowlist's headline sentence, which is prose and not a row, and so is
  // the one number in the section that could once say anything at all.
  const headline = /\*\*(\d+) occurrences in (\d+) files, counted /.exec(section);
  expect(headline, "doc/reference.md's allowlist does not say how big it is").not.toBeNull();
  // And the English table's own sentence, which is the same shape a second
  // time: a number in prose, over a table that is going to shrink under it.
  const inEnglish = /\*\*(\d+) of those (\d+) occurrences are the English word/.exec(section);
  expect(inEnglish, "doc/reference.md does not say how much of the allowlist is ordinary English").not.toBeNull();
  return {
    /** What the section's own sentence claims the table below it comes to. */
    headline: { occurrences: Number(headline![1]), files: Number(headline![2]) },
    /**
     * *`9` of those `1079`* — the English table's headline, held to that table
     * and to the allowlist's size. **It is the only place that nine is written
     * down**: a test that kept its own copy would red the `build` gate on the
     * diff that rewords one of those sentences, and send its author to edit a
     * file the section says holds no copy of the debt.
     */
    englishHeadline: { english: Number(inEnglish![1]), of: Number(inEnglish![2]) },
    /** The four lowercase words, matched inside any token. */
    retired: glossaryRows.filter((r) => /^[a-z]+$/.test(r[0]!)).map((r) => r[0]!),
    /** `GatePoint` → `Step` and `GateAction` → `Plugin`: a replacement the word rules do not give. */
    named: glossaryRows.filter((r) => !/^[a-z]+$/.test(r[0]!)).map((r) => [r[0]!, r[1]!] as const),
    /**
     * Tokens that carry a retired word glued to a letter, where the whole-word
     * match cannot see it — `words("sgate")` is `["sgate"]`, which is on no
     * list. Matched **by token and everywhere**, which is the opposite door to
     * the exemptions: a row here only ever adds violations, and every one of
     * them costs a count in the allowlist.
     */
    glued: rows("the glued tokens").map((r) => r[0]!),
    /**
     * Tokens that carry one of the words and are not the retired concept, each
     * with **the one file it is excused in**. A bare token would excuse the
     * same spelling in every one of them.
     */
    exempt: rows("not the retired name").map((r) => [r[0]!, r[1]!] as const),
    /** file → token → how many times, which is the ledger itself. */
    allowlist: new Map(rows("the allowlist").map((r) => [r[0]!, counts(r[1]!)])) as Counted,
    /**
     * The occurrences inside the allowlist that are the English word and not the
     * retired term. **This excuses nothing** — every one is still counted above;
     * the table says which counts a rename will not reach, so `#233` inherits
     * them rather than discovering them. `1 of 2` is *one of this row's two*.
     */
    english: rows("ordinary English").map((r) => {
      const said = /^(\d+) of (\d+)$/.exec(r[2]!);
      expect(said, `doc/reference.md's English table says "${r[2]}", which is not "<n> of <n>"`).not.toBeNull();
      return { file: r[0]!, token: r[1]!, english: Number(said![1]), of: Number(said![2]) };
    }),
  };
}

/** The real one, which is `doc/reference.md` and nowhere else. */
async function glossary() {
  return parse(await readFile(`${root}doc/reference.md`, "utf8"));
}

/**
 * **The two ways the ledger and `src/` can disagree, and there are only two.**
 * `unrecorded` is a retired name the ledger is short on — a name with no row at
 * all, or, just as much, one more use of a name that already has one. `stale` is
 * a count with nothing behind it — a rename that landed and left its ledger
 * standing, which is how *align the terms* ends as a sentence everybody agrees
 * with and the last ticket discovers is untrue.
 *
 * **Both are counted rather than set against each other**, and that is what
 * makes the table the debt rather than a bound on it. Keyed by distinct
 * `file · token`, a second `gate` in a file that already says `gate` is a pair
 * already present and nothing moves — which is every file this epic will touch.
 *
 * A file that moves shows up as one of each, naming the path to delete and the
 * path to add — two edits to the document a person is already reading, and to
 * nothing else.
 */
function disagreement(found: Counted, allowlist: Counted) {
  const flat = (table: Counted) =>
    new Map([...table].flatMap(([file, ours]) => [...ours].map(([token, n]) => [`${file} · ${token}`, n] as const)));
  const real = flat(found);
  const recorded = flat(allowlist);

  const unrecorded: string[] = [];
  const stale: string[] = [];
  for (const pair of new Set([...real.keys(), ...recorded.keys()])) {
    const says = real.get(pair) ?? 0;
    const ledger = recorded.get(pair) ?? 0;
    if (says > ledger) unrecorded.push(`${pair} — src/ reads ${says}, the ledger says ${ledger}`);
    else if (ledger > says) stale.push(`${pair} — src/ reads ${says}, the ledger says ${ledger}`);
  }
  return { unrecorded: unrecorded.sort(), stale: stale.sort() };
}

/** What a table of `file → token → count` comes to, as the document says it. */
function size(allowlist: Counted) {
  return {
    occurrences: [...allowlist.values()].reduce((n, ours) => n + [...ours.values()].reduce((m, c) => m + c, 0), 0),
    files: allowlist.size,
  };
}

/** What `src/` actually says today: file → token → how many times the rule reads it. */
async function violations(g: ReturnType<typeof parse>): Promise<Counted> {
  const retired = new Set(g.retired);
  const glued = new Set(g.glued);
  const exempt = new Set(g.exempt.map(([token, file]) => `${file} · ${token}`));
  const found = new Map<string, Map<string, number>>();
  for (const file of await sources()) {
    const hit = new Map<string, number>();
    for (const token of tokens(await readFile(`${root}${file}`, "utf8"), file)) {
      if (exempt.has(`${file} · ${token}`)) continue;
      if (glued.has(token) || words(token).some((w) => retired.has(w))) hit.set(token, (hit.get(token) ?? 0) + 1);
    }
    if (hit.size > 0) found.set(file, new Map([...hit].sort(([a], [b]) => (a < b ? -1 : 1))));
  }
  return found;
}

describe("the retired names in doc/reference.md", () => {
  it("names four words and reads them out of the document", async () => {
    const g = await glossary();

    expect(g.retired).toEqual(["gate", "gates", "point", "points"]);
    expect(g.named.map(([old]) => old)).toEqual(["GatePoint", "GateAction"]);
    expect(Object.fromEntries(g.named)).toEqual({ GatePoint: "Step", GateAction: "Plugin" });
  });

  /**
   * **The half a rule of whole words cannot see.** `words("sgate")` is
   * `["sgate"]` — one word, and on no list — so the same match that saves
   * `checkpoint` passes `className="sgate"` over with it, three times in the
   * standing block and once more as `actpoint` on the task page, every one of
   * them a string the board renders. The way out is not a substring ban, which
   * takes `checkpoint`, `pointer` and `pointed` down with it; it is a short list
   * of the tokens somebody actually looked at.
   *
   * **This door only opens inwards**, which is what makes it unlike the
   * exemptions below: a row here can add a violation and can excuse none, so it
   * costs its counts in the allowlist and raises the headline in the same diff.
   * It is pinned here all the same, because taking a row *out* is the other
   * direction — the counts it was holding up leave with it.
   */
  it("matches two tokens the words are glued into, and the pair is pinned here", async () => {
    const g = await glossary();
    const retired = new Set(g.retired);

    expect(g.glued).toEqual(["sgate", "actpoint"]);
    // A row is for what the words cannot reach and for nothing else: a token
    // they already split needs none, and one carrying no retired word at all is
    // a rename this glossary never decided.
    for (const token of g.glued) {
      expect(words(token), `${token} splits — the words above already reach inside it`).toEqual([token]);
      expect(words(token).some((w) => retired.has(w)), `${token} is matched already, without a row`).toBe(false);
      expect(g.retired.some((w) => token.includes(w)), `${token} carries none of the four words`).toBe(true);
    }
  });

  /**
   * **And the row is the whole of what counts them.** Emptying the list leaves
   * the rule reading the same strings and walking past them — the state this
   * ledger shipped in, where `sgate` sat in three JSX strings under a row that
   * said `gate ×4` and in a stylesheet nothing read at all. Taken against the
   * allowlist rather than against a number here, so the day one of these is
   * renamed away its row goes and this asks for nothing.
   */
  it("counts a glued token where the words alone walk past it", async () => {
    const g = await glossary();
    const held = [...g.allowlist]
      .flatMap(([file, ours]) =>
        [...ours].filter(([token]) => g.glued.includes(token)).map(([token, n]) => `${file} · ${token} — src/ reads 0, the ledger says ${n}`),
      )
      .sort();

    expect(
      disagreement(await violations({ ...g, glued: [] }), g.allowlist),
      "with the glued list emptied, the ledger loses exactly what those rows were holding up — and gains nothing",
    ).toEqual({ unrecorded: [], stale: held });
  });

  /**
   * **The other door, and it is bolted differently.** An exemption is not a row
   * in a ledger, it is a `continue` before the match — so one row added here
   * excuses its token everywhere at once and nothing underneath it moves: the
   * allowlist does not grow, the headline is unchanged, and a brand-new retired
   * name is green in every file at once. It is the one edit to that section a
   * reader cannot size by reading it, and the door is small enough to nail shut:
   * two pairs, reviewed once, pinned here exactly as the four words are. A row
   * added, deleted or repointed is this test going red, and the same
   * `doc/reference.md` still holds the rows a person reads.
   */
  it("excuses two tokens, each in one named file, and the pair is pinned here", async () => {
    const g = await glossary();

    expect(g.exempt.map(([token, file]) => `${file} · ${token}`)).toEqual([
      "apps/cli/src/install.ts · pointShim",
      "apps/release/src/build.ts · entryPoints",
    ]);
  });

  /**
   * **And neither of them is one of the four words spelled out.** That is the
   * property that keeps this door small, and it is worth a case of its own: a
   * row excusing the bare token `point` in a file would excuse the step there
   * too, and the step is what the ledger is for. It is why the nine English
   * occurrences below are *listed* rather than excused.
   */
  it("excuses no token that is itself one of the four words", async () => {
    const g = await glossary();
    const retired = new Set(g.retired);

    for (const [token, file] of g.exempt) {
      expect(retired.has(token), `${token} is excused in ${file}, and the retired term is spelled the same`).toBe(false);
    }
  });

  /**
   * And the file column is the rule and not a note: `pointShim` is the English
   * verb **in `install.ts`**, and a `pointShim` somewhere else is a token
   * nobody reviewed.
   *
   * **Taken as the difference the row makes, not as the file's contents.**
   * Pinning what `install.ts` comes to would be a copy of the ledger here, in
   * the file that keeps none — and `install.ts` is the file the *ordinary
   * English* table sends `#233` to reword, so it would red the `build` gate on
   * the very diff that section describes, over a row three subsections away
   * that nothing had asked anybody to look at.
   */
  it("excuses a token only in the file the document names", async () => {
    const g = await glossary();
    const file = "apps/cli/src/install.ts";
    const elsewhere = { ...g, exempt: g.exempt.filter(([, where]) => where !== file) };
    const excused = (await violations(g)).get(file) ?? new Map<string, number>();
    const read = (await violations(elsewhere)).get(file) ?? new Map<string, number>();

    expect(
      [...read.keys()].filter((token) => !excused.has(token)),
      "lifting install.ts's exemption changed what is read of some token it does not name",
    ).toEqual(["pointShim"]);
  });

  /**
   * A named row that the words do not already catch would be a rule with no
   * enforcement behind it — read by a person, checked by nothing. Both rows
   * exist to say what the replacement *is*, not to widen what is matched.
   */
  it("catches every named token through the words, so a named row only says what to put there", async () => {
    const g = await glossary();
    const retired = new Set(g.retired);

    for (const [old] of g.named) {
      expect(words(old).some((w) => retired.has(w)), `${old} is on no word's list — nothing enforces that row`).toBe(true);
    }
  });

  /**
   * **The trap this ticket was written about.** `checkpoint` and `checkpoints`
   * are the projector's; `pointer` and `pointed` are the installer's and the
   * environment's. A substring ban on `point` flags all four and takes a
   * vocabulary that was never ours down with it.
   *
   * Asserted against the real matcher rather than against a list.
   */
  it("does not reach inside a word — checkpoint, checkpoints, pointer and pointed are not ours", async () => {
    const g = await glossary();
    const retired = new Set(g.retired);
    const innocent = ["checkpoint", "checkpoints", "pointer", "pointed"];

    for (const token of innocent) {
      expect(words(token), `${token} was split into pieces`).toEqual([token]);
      expect(words(token).some((w) => retired.has(w)), `${token} is flagged`).toBe(false);
      // And not by being excused, which would be a weaker guarantee: an
      // exemption is a judgement somebody has to keep making, and the shape of
      // the match is not.
      expect(
        g.exempt.some(([excused]) => excused === token),
        `${token} needs no exemption — whole-word matching already leaves it alone`,
      ).toBe(false);
      // And not on the glued list either, which is the door that *widens* the
      // match: `sgate` belongs there because it is the gate; `checkpoint` is
      // the same shape and is not ours, and one row would flag all 9 of it.
      expect(
        g.glued.includes(token),
        `${token} is on the glued list — the widening door, opened on a word that was never ours`,
      ).toBe(false);
    }

    // And live **to the rule**, not to a grep. Asserting a live subject against
    // the raw file text is the mistake to make here: the rule reads no comment,
    // so a text guard reports a subject the matcher can never be handed and
    // stays green with every one of these identifiers renamed away.
    const read = new Set(
      (await Promise.all((await sources()).map(async (f) => tokens(await readFile(`${root}${f}`, "utf8"), f)))).flat(),
    );

    for (const token of ["checkpoint", "checkpoints"]) {
      expect(read.has(token), `the rule reads no ${token} in src/ — this case has gone stale`).toBe(true);
    }

    // `pointer` and `pointed` are the other two, and they are **not** in that
    // loop. All 17 of `pointer`'s occurrences are comments today —
    // `standing.tsx:63`, `latch.tsx:89`, `task/[id]/page.tsx:139` — and the rule
    // reads none of them; every one of `pointed`'s seven reads is the single
    // local `const pointed = shim ?? current` at `apps/cli/src/install.ts:465`
    // and its uses. Which way round either goes is a fact about `src/` and not a
    // rule, so neither direction is asserted for either: *the rule reads no
    // `pointer`* makes a `style={{ cursor: "pointer" }}` a red `build` gate, and
    // *the rule reads `pointed`* makes an ordinary rename of that one local a
    // red `build` gate — both on a diff that introduces no retired name, and
    // both with no action in the failure a reader could take. `checkpoint` (9
    // reads in 7 files) and `checkpoints` (22 in 5) carry the live half, and
    // carry it on more than one identifier each. What is true of all four
    // whether they are live or not is that nothing flags them, and that is
    // asserted here over every file, through the rule a violation really goes
    // through — exemptions and all.
    const flagged = [...(await violations(g))].flatMap(([file, found]) =>
      [...found.keys()].filter((t) => innocent.includes(t)).map((t) => `${file} · ${t}`),
    );

    expect(flagged, "a word that was never ours was flagged as a retired name").toEqual([]);
  });

  /**
   * **The scope, which the document states in four clauses and this checks in
   * three.** Comments are the fourth and are handled by the scanner above, where
   * *reads no comment* is the case for them. `doc/` is read for the tables and
   * never for violations, which is the ticket's own line: a document describing
   * history keeps the name it happened under. And everything outside
   * `{apps,packages}/*<!---->/src/` is out — mostly **the two test halves**,
   * which really do carry retired names a rename of `src/` will not reach.
   *
   * The third is **the extensions**, and it is the clause a stylesheet slipped
   * through: `globals.css` sits inside the region the document calls enforced
   * and says `.point`, `.points`, `.sgate` and `.actpoint` — the same words the
   * `className`s beside it do. A rule that read the strings and not the
   * selectors would let `#233` report `0 occurrences in 0 files` over a
   * stylesheet still naming the retired concept, with the class now matching
   * nothing in the TSX: two vocabularies and a dead rule, under a green gate. So
   * `.css` is read, and `.prisma` and the `.json` beside it — generated, and
   * renamed with the schema they come from — are named as being out. **Both
   * halves of that are checked, and they are not one assertion.** The
   * extensions of what was read hold `READS` itself; the files `src/` holds
   * and `READS` walks past hold the sentence the document makes about them,
   * which is the half the first cannot reach — a new extension under `src/` is
   * filtered out before anything looks at it, which is how a stylesheet sat
   * inside the enforced region unread.
   *
   * Every one of those is a boundary rather than an oversight, and what makes it
   * one is that it is stated in the document, checked here, and cannot widen or
   * narrow without this going red.
   */
  it("reads doc/reference.md for the tables and {apps,packages}/*/src/ for the violations, and nothing else", async () => {
    const files = await sources();

    expect(files.length).toBeGreaterThan(100);
    expect(files.filter((f) => f.startsWith("doc/")), "a document was read for violations").toEqual([]);
    expect(
      files.filter((f) => !/^(apps|packages)\/[^/]+\/src\//.test(f)),
      "something outside {apps,packages}/*/src/ was read",
    ).toEqual([]);
    // Named separately from the line above, which already implies it, because
    // it is the clause a reader comes here to check: `packages/*/unit/`,
    // `integration/` and `test/` are the halves `#233` sweeps with a grep on
    // the day the last row goes, and they are out of this rule until then.
    expect(files.filter((f) => /\/(unit|integration|test)\//.test(f)), "a test was read").toEqual([]);
    // And the extensions, both ways at once: a `.css` inside that region is
    // read, because the board's class vocabulary is the same words its JSX is,
    // and nothing else there is — `contract.prisma` and the `contract.json`
    // beside it are generated from a schema and renamed with it. It is the
    // extensions of what was really read, so widening `READS` over a file
    // `src/` already holds is this line going red rather than rows appearing
    // unannounced, and dropping one is the same line from the other side.
    expect(
      [...new Set(files.map((f) => f.slice(f.lastIndexOf("."))))].sort(),
      "the rule read an extension the document does not name, or stopped reading one it does",
    ).toEqual([".css", ".ts", ".tsx"]);
    // **And the complement, which the line above cannot see.** It maps over
    // what `READS` already admitted, so it reds on the filter widening or
    // narrowing and never on a file the filter walks past — and a file the
    // filter walks past is exactly what `globals.css` was. An
    // `apps/board/src/app/plan.module.scss` carrying `.point` and `.sgate`
    // lands inside the enforced region, is dropped by `sources()`, appears in
    // no row, and leaves every line above green: the stylesheet hole again,
    // one extension out. So what `src/` holds and the rule does not read is
    // named here, as the document names it — two generated files, renamed with
    // the schema they come from — and a third arrival is this going red until
    // somebody reads it or writes it down.
    expect(
      (await everything()).filter((file) => !READS.test(file)),
      "src/ holds a file the rule does not read and doc/reference.md does not name — read it, or name it there",
    ).toEqual(["packages/event-store/src/prisma/contract.json", "packages/event-store/src/prisma/contract.prisma"]);
  });
});

/**
 * **The ledger is only as honest as what reads `src/`.** Every case here is a
 * shape the first version of the reader got wrong, and each one was silent: a
 * scanner that returns less of a file than it was given makes *is exactly what
 * src/ says today* green over names it never looked at.
 */
describe("the scanner", () => {
  /**
   * The defect `#232` shipped with, and the reason the allowlist below has a
   * `plan.tsx` row now: `</p>`'s `/` was read as the opening of a regex literal
   * and the 3255 characters to the next `/` were discarded.
   */
  it("keeps the code after a JSX closing tag", () => {
    const read = tokens(
      ["const F = ({ plan }: { plan: PlanView }) => (", "  <div>", "    <p>not read</p>", "    <ol>{plan.points.map((p) => p.point)}</ol>", "  </div>", ");", ""].join("\n"),
      "f.tsx",
    );

    expect(read).toContain("points");
    expect(read).toContain("point");
  });

  /** `{p.points} />` closes a tag; `}` is not the end of something divisible. */
  it("keeps the code after a self-closing JSX tag", () => {
    const read = tokens(["const F = () => (", "  <>", "    <Segs points={p.points} />", "    <b>{p.point}</b>", "  </>", ");", ""].join("\n"), "f.tsx");

    expect(read).toContain("points");
    expect(read).toContain("point");
  });

  /**
   * JSX copy is text and not a string literal, so the apostrophe in *a person's
   * word* opens nothing. A scanner that thinks it does swallows the code under
   * it as far as the next quote, which is the same defect as the one above
   * reached from the other side.
   */
  it("keeps the code after an apostrophe in JSX copy", () => {
    const read = tokens(["const F = () => (", "  <p>a person's word, standing in for a gate {count}</p>", ");", "const later = run.points;", ""].join("\n"), "f.tsx");

    expect(read).toContain("gate");
    expect(read).toContain("points");
  });

  /**
   * **And it reads no comment**, which is the other half and is what the
   * document promises: a comment about the past keeps the name the past happened
   * under. `{/* … *\/}` is in here because the mis-parse above swallowed the
   * `/*` that opens one and handed its prose over as code — that is where five
   * of the rows this ticket first shipped came from.
   */
  it("reads no comment, in any of the four ways this repository writes one", () => {
    const read = tokens(
      ["/** A gate at a point. */", "// gates and points", "/* GateAction */", "export const F = () => <p>{/* the gate plan */}kept</p>;", ""].join("\n"),
      "f.tsx",
    );

    expect(read).toContain("kept");
    expect(read.filter((t) => words(t).some((w) => ["gate", "gates", "point", "points"].includes(w)))).toEqual([]);
  });

  /**
   * **And the other half of a class name.** `className="point"` is read from the
   * `.tsx` as a string; `.point` is read from the stylesheet as a selector, and
   * the two are renamed together or the rule is left matching nothing. A
   * declaration is not read — `cursor: pointer` is a language nobody here
   * renames — and neither is a length, which is where a naive `.` would find
   * `.55rem` and a class called `55rem`.
   */
  it("reads a stylesheet's class selectors and nothing under them", () => {
    const read = tokens(
      [".point { padding: 0.3rem 0.55rem; cursor: pointer; grid-template-columns: 5.5rem 1fr; }", ".plan .points > .sgate { color: var(--ink-2); }", ""].join("\n"),
      "globals.css",
    );

    expect(read).toEqual(["point", "plan", "points", "sgate"]);
  });

  /** And a stylesheet's comments go the way a `.ts`'s do, for the same reason. */
  it("reads no comment in a stylesheet", () => {
    const read = tokens(["/* A person's word standing in for a gate. Never `.points`. */", ".kept { color: var(--ink-2); }", ""].join("\n"), "globals.css");

    expect(read).toEqual(["kept"]);
  });

  /** A regex literal's body is neither code a person renames nor copy one reads. */
  it("reads a string but not a regex literal's body", () => {
    const read = tokens('const re = /gates/;\nconst s = "gate";\n', "f.ts");

    expect(read).toContain("gate");
    expect(read).not.toContain("gates");
  });

  /** A template hole is code, and the chunks either side of it never fuse. */
  it("keeps a template's holes and its text apart", () => {
    const read = tokens("const s = `review${n}gates`;\n", "f.ts");

    expect(read).toContain("review");
    expect(read).toContain("gates");
    expect(read).not.toContain("reviewngates");
  });

  /**
   * **A `.ts` file is parsed as `.ts`.** Under `TSX` the generic arrow below is
   * an element — `propose.ts:132`'s `const get = <T>(path: string) =>` is the
   * real one — and the lines after it are its children, which handed that
   * file's comments over as text and invented a `gate` no line of its code says.
   * A `<T,>` would be safe in either; the repository writes `<T>`.
   */
  it("parses a .ts generic arrow as a generic arrow", () => {
    const src = ["const id = <T>(x: T): T => x;", "// the gate at a point", "export const y = id(1);", ""].join("\n");

    expect(tokens(src, "f.ts")).not.toContain("gate");
    expect(tokens(src, "f.tsx")).toContain("gate");
  });

  /** Every read counts, and the same name twice in one file is two of them. */
  it("counts a name once per read, not once per file", () => {
    const read = tokens('const gate = 1;\nconst s = "the gate refused at the gate";\nexport { gate };\n', "f.ts");

    // The declaration, twice in one string, and the re-export.
    expect(read.filter((t) => t === "gate")).toHaveLength(4);
  });

  /**
   * **A module specifier is read, and that is the decision rather than a
   * side-effect of reading string literals.** Eight files under `src/` carry a
   * retired word in their own name and each is renamed by the ticket that
   * renames what is inside it; an import of `./gate.ts` is the only place a
   * ledger over file contents can count that. `packages/actions/src/index.ts`'s
   * `gate` ×5 is five re-export lines and no identifier at all, which is the
   * row that would be wrong if this ever stopped being true.
   */
  it("reads a module specifier, so a file named for a retired word is counted where it is imported", () => {
    const read = tokens('export { createWatchGate } from "./watch-gate.ts";\n', "f.ts");

    expect(read.filter((t) => t === "gate")).toHaveLength(1);
    expect(read).toContain("createWatchGate");
  });
});

/**
 * **What the ledger refuses, as cases rather than as today's document agreeing
 * with today's `src/`.** Both are correct as this lands, so *is exactly what
 * src/ says today* below is green whatever the rule does; these are what say it
 * is green for a reason. Each case writes a `## retired name` section, parses it
 * with the same parser the document goes through, and reads it against a `src/`
 * it states — so *one more use of a listed name is red* is asserted rather than
 * described.
 */
describe("the ledger", () => {
  /**
   * What the English sentence says when nothing has drifted: the table under it,
   * and the allowlist it is a subset of. A case that wants drift states it.
   */
  const consistent = (rows: string[], english: string[]): string => {
    const sum = (lines: string[], re: RegExp) =>
      lines.flatMap((line) => [...line.matchAll(re)]).reduce((n, said) => n + Number(said[1]), 0);
    return `${sum(english, /\|\s*(\d+) of \d+\s*\|/g)} of those ${sum(rows, /×\s*(\d+)/g)}`;
  };

  /** A section with the headline and the rows a case wants, and nothing else. */
  const written = (headline: string, rows: string[], english: string[] = [], says = consistent(rows, english)) =>
    parse(
      [
        "# Reference",
        "",
        "## retired name — 4 words, and an allowlist that may only shrink",
        "",
        "### the words",
        "",
        "| retired | current | decided by |",
        "|---|---|---|",
        "| `gate` | `step` | 0058 |",
        "| `point` | `step` | 0058 |",
        "",
        "### the glued tokens",
        "",
        "| token | current | what it is |",
        "|---|---|---|",
        "",
        "### not the retired name",
        "",
        "| token | where | what it is |",
        "|---|---|---|",
        "",
        "### the allowlist",
        "",
        `**${headline}, counted 2026-09-23** — and that sentence is counted.`,
        "",
        ...(rows.length > 0 ? ["| file | retired names in it |", "|---|---|"] : []),
        ...rows,
        "",
        "### ordinary English",
        "",
        `**${says} occurrences are the English word and not the retired term**, and nothing tells them apart.`,
        "",
        ...(english.length > 0 ? ["| file | token | of which English | the sentence |", "|---|---|---|---|"] : []),
        ...english,
        "",
        "## the next term",
        "",
      ].join("\n"),
    );

  const filter = "packages/conductor/src/filter.ts";
  const counted = (ours: Record<string, number>) => new Map(Object.entries(ours));
  const src: Counted = new Map([[filter, counted({ GatePlan: 2, gatePlan: 3, gates: 1, point: 4 })]]);
  const row = (file: string, ours: string) => `| \`${file}\` | ${ours} |`;
  const four = "`GatePlan` ×2 · `gatePlan` ×3 · `gates` ×1 · `point` ×4";

  it("passes when the table is what src/ says", () => {
    expect(disagreement(src, written("10 occurrences in 1 files", [row(filter, four)]).allowlist)).toEqual({
      unrecorded: [],
      stale: [],
    });
  });

  /**
   * **The Done-when, in one case.** A row is not a claim a person makes, it is a
   * claim about `src/`, so writing one down that nothing backs is as red as a
   * retired name nobody wrote down. That is what stops the allowlist being
   * widened on its own — a row costs a violation to go with it.
   */
  it("reds a row with nothing behind it", () => {
    const added = written("11 occurrences in 2 files", [row(filter, four), row("packages/conductor/src/close.ts", "`gates` ×1")]);

    expect(disagreement(src, added.allowlist).stale).toEqual([
      "packages/conductor/src/close.ts · gates — src/ reads 0, the ledger says 1",
    ]);
  });

  /** And the other direction: a name that arrived and was not written down. */
  it("reds a retired name that no row records", () => {
    const arrived: Counted = new Map([[filter, counted({ GatePlan: 2, gatePlan: 3, gateStep: 1, gates: 1, point: 4 })]]);

    expect(disagreement(arrived, written("10 occurrences in 1 files", [row(filter, four)]).allowlist).unrecorded).toEqual([
      `${filter} · gateStep — src/ reads 1, the ledger says 0`,
    ]);
  });

  /**
   * **The hole a set had, and the one this ticket exists to close.** The name is
   * already in the table and the file is already listed, so a ledger of distinct
   * `file · token` pairs sees nothing: `export const gate = "…the gate failed"`
   * appended to a file that already says `gate` is a new identifier and a new
   * operator-facing string arriving under a row that does not move. **Every file
   * this epic will touch already says `gate` or `point` once**, so that is not a
   * corner — it is the ordinary case. The count is what sees it, and the failure
   * names the file, the token and both numbers.
   */
  it("reds one more use of a name the table already carries", () => {
    const grown: Counted = new Map([[filter, counted({ GatePlan: 2, gatePlan: 3, gates: 1, point: 7 })]]);

    expect(disagreement(grown, written("10 occurrences in 1 files", [row(filter, four)]).allowlist)).toEqual({
      unrecorded: [`${filter} · point — src/ reads 7, the ledger says 4`],
      stale: [],
    });
  });

  /** And the same equality from the other side: a use deleted needs its count lowered. */
  it("reds a count left standing when a use went", () => {
    const shrunk: Counted = new Map([[filter, counted({ GatePlan: 2, gatePlan: 3, gates: 1, point: 1 })]]);

    expect(disagreement(shrunk, written("10 occurrences in 1 files", [row(filter, four)]).allowlist)).toEqual({
      unrecorded: [],
      stale: [`${filter} · point — src/ reads 1, the ledger says 4`],
    });
  });

  /** A row that says a name but not how many times is a row the parser refuses. */
  it("refuses a row that gives no count", () => {
    expect(() => written("10 occurrences in 1 files", [row(filter, "`GatePlan` · `point`")])).toThrow(/says no count/);
  });

  /**
   * **Deleting a row is free, and that is the half a rename ticket lives on.**
   * The name went, the row goes with it, and nothing else is edited — no second
   * table, no baseline, no ceremony beyond the number above.
   */
  it("passes when a row goes because the name went", () => {
    const close = "packages/conductor/src/close.ts";
    const before: Counted = new Map([...src, [close, counted({ gates: 1 })]]);
    const both = written("11 occurrences in 2 files", [row(filter, four), row(close, "`gates` ×1")]);
    // `close.ts`'s `gates` renamed away: its row goes, the other stays.
    const after = written("10 occurrences in 1 files", [row(filter, four)]);

    expect(disagreement(before, both.allowlist)).toEqual({ unrecorded: [], stale: [] });
    expect(disagreement(src, after.allowlist)).toEqual({ unrecorded: [], stale: [] });
  });

  /** Deleting a row the name is still behind is the debt it still is. */
  it("reds a row deleted while the name stays", () => {
    expect(
      disagreement(src, written("6 occurrences in 1 files", [row(filter, "`GatePlan` ×2 · `gatePlan` ×3 · `gates` ×1")]).allowlist),
    ).toEqual({ unrecorded: [`${filter} · point — src/ reads 4, the ledger says 0`], stale: [] });
  });

  /**
   * **A file that moved is two row edits, in the document, and nothing else.**
   * This is the case that decided against a frozen `file → tokens` copy in this
   * file: the epic renames files by construction — `gate-audit.ts`,
   * `gates-resolved.ts`, `agent-gate.ts` — and a baseline keyed by path reads
   * every one of those as a widening that did not happen, answered by
   * hand-editing the one table whose edits are meant to be expensive. Here the
   * failure names the path to delete and the path to add, both of them rows a
   * person is already reading, and neither of them in a test.
   */
  it("names both paths when a file moves, and asks for nothing else", () => {
    const to = "packages/conductor/src/step/filter.ts";
    const moved: Counted = new Map([[to, src.get(filter)!]]);
    const ours = [
      ["GatePlan", 2],
      ["gatePlan", 3],
      ["gates", 1],
      ["point", 4],
    ] as const;

    expect(disagreement(moved, written("10 occurrences in 1 files", [row(filter, four)]).allowlist)).toEqual({
      unrecorded: ours.map(([token, n]) => `${to} · ${token} — src/ reads ${n}, the ledger says 0`),
      stale: ours.map(([token, n]) => `${filter} · ${token} — src/ reads 0, the ledger says ${n}`),
    });
    // And the edit the failure asks for is that row's path, in the document.
    expect(disagreement(moved, written("10 occurrences in 1 files", [row(to, four)]).allowlist)).toEqual({
      unrecorded: [],
      stale: [],
    });
  });

  /**
   * **`0 occurrences in 0 files` is a state this passes, not one it refuses** —
   * it is `#233`'s acceptance, and a lower bound under the table would red the
   * `build` gate on the diff that finishes the epic. Nothing guards against an
   * empty parse either, because nothing has to: while `src/` still carries debt
   * an empty table is red on the rule above, and when it carries none an empty
   * table is the truth.
   */
  it("passes on the empty allowlist #233 is aiming at", () => {
    const empty = written("0 occurrences in 0 files", []);

    expect(empty.allowlist.size).toBe(0);
    expect(size(empty.allowlist)).toEqual(empty.headline);
    expect(disagreement(new Map(), empty.allowlist)).toEqual({ unrecorded: [], stale: [] });
  });

  /**
   * **And the headline is the number a review reads the direction off.** The
   * test cannot tell a retired name that had to arrive from one that did not —
   * nothing can — so what it does is make that sentence true: a row added, a row
   * deleted or a count moved without correcting it is red, and raising it is one
   * line in a diff, saying what it is counting.
   */
  it("counts the table rather than reading the sentence above it", () => {
    const left = written("1064 occurrences in 76 files", [row(filter, four)]);

    expect(left.headline, "the sentence, as the document says it").toEqual({ occurrences: 1064, files: 76 });
    expect(size(left.allowlist), "the table, counted — and what the document is held to").toEqual({ occurrences: 10, files: 1 });
  });

  /**
   * **The English table excuses nothing, and is held to the one that does.** Its
   * rows say which of the allowlist's counts a rename will not reach, so a row
   * naming a file or token the allowlist does not carry — or claiming more
   * English than the ledger counts at all — is a claim about `src/` with nothing
   * behind it, exactly like a stale row.
   */
  it("reds an English row the allowlist does not carry", () => {
    const table = (cells: string) => written("10 occurrences in 1 files", [row(filter, four)], [cells]);
    const held = (g: ReturnType<typeof parse>) => english(g);

    expect(held(table(`| \`${filter}\` | \`point\` | 2 of 4 | *would point at* |`))).toEqual([]);
    expect(held(table(`| \`${filter}\` | \`point\` | 5 of 4 | *more English than there are* |`))).toEqual([
      `${filter} · point — 5 English of a count the ledger puts at 4`,
    ]);
    expect(held(table(`| \`${filter}\` | \`gate\` | 1 of 1 | *a token no row carries* |`))).toEqual([
      `${filter} · gate — the allowlist does not carry it`,
    ]);
    expect(held(table("| `packages/conductor/src/close.ts` | `gates` | 1 of 1 | *a file no row carries* |"))).toEqual([
      "packages/conductor/src/close.ts · gates — the allowlist does not carry it",
    ]);
  });

  /**
   * **And that table has a headline too, which is the one number this test file
   * must not keep a copy of.** *9 of those 1079* sits over a table `#233`
   * shrinks: rewording the installer's three `points at` sentences deletes an
   * English row, an allowlist row and lowers both sentences — four edits, every
   * one of them in `doc/reference.md`. A `toBe(9)` here would be a fifth, in the
   * file the section says holds no copy of the debt, and it would red the
   * `build` gate on the diff that did the documented work correctly. So the nine
   * is read from the document and held to the table under it, both ways.
   */
  it("reds an English sentence that is not the table under it, or not the ledger beside it", () => {
    const table = [`| \`${filter}\` | \`point\` | 2 of 4 | *would point at* |`];
    const said = (says?: string) => written("10 occurrences in 1 files", [row(filter, four)], table, says);

    expect(said().englishHeadline, "the sentence, as a document that has not drifted says it").toEqual({
      english: 2,
      of: 10,
    });
    expect(english(said("3 of those 10"))).toEqual(["the section says 3 of them are English, its own table comes to 2"]);
    expect(english(said("2 of those 9"))).toEqual(['the section says "of those 9", the allowlist comes to 10']);
  });
});

/**
 * Where the English table and the allowlist disagree, which must be nowhere —
 * **and the sentence above that table is one of the rows**. *9 of those 1079*
 * is a number over a table that shrinks, exactly as the allowlist's headline is,
 * and it is counted here for the same reason: the day somebody rewords the three
 * `points at` sentences in the installer, the row goes, the sentence is wrong,
 * and the only edits either of them costs are in the document.
 */
function english(g: ReturnType<typeof parse>): string[] {
  const said = g.englishHeadline;
  const table = g.english.reduce((n, row) => n + row.english, 0);
  const ledger = size(g.allowlist).occurrences;
  return [
    ...g.english.flatMap((row) => {
      const carried = g.allowlist.get(row.file)?.get(row.token);
      if (carried === undefined) return [`${row.file} · ${row.token} — the allowlist does not carry it`];
      if (row.of !== carried) return [`${row.file} · ${row.token} — says "of ${row.of}", the allowlist says ${carried}`];
      if (row.english > carried) return [`${row.file} · ${row.token} — ${row.english} English of a count the ledger puts at ${carried}`];
      return [];
    }),
    ...(said.english === table ? [] : [`the section says ${said.english} of them are English, its own table comes to ${table}`]),
    ...(said.of === ledger ? [] : [`the section says "of those ${said.of}", the allowlist comes to ${ledger}`]),
  ];
}

describe("the allowlist", () => {
  /**
   * The whole ticket, in one assertion, and it is an equality over counts rather
   * than a subset over names on purpose. A count `src/` is over is new debt — a
   * name nobody wrote down, or one more use of a name somebody did; **a count
   * `src/` is under is a rename that landed and left its ledger behind**, which
   * is how *align the terms* becomes a sentence everybody agrees with and the
   * last ticket discovers is untrue.
   */
  it("is exactly what src/ says today", async () => {
    const g = await glossary();
    const found = await violations(g);

    expect(
      disagreement(found, g.allowlist),
      "doc/reference.md's allowlist and src/ disagree — `unrecorded` is debt the ledger is short on, `stale` is a count with nothing behind it",
    ).toEqual({ unrecorded: [], stale: [] });
  });

  /**
   * **And the section's own headline is the other thing that may not drift.**
   * `1079 occurrences in 77 files` is what `#233` sizes the remaining debt from,
   * and it is what a rename ticket makes wrong by deleting rows: take the
   * `projector` and `event-store` rows away — eight of them — and nothing parsed
   * that sentence, so the equality above stayed green while the headline said
   * one number and the table underneath it came to another. It is counted here
   * rather than remembered, so correcting it is part of deleting a row — and
   * part of adding one, and part of raising a count by one.
   */
  it("says how big it is, and that sentence is counted rather than remembered", async () => {
    const g = await glossary();

    expect(size(g.allowlist), "doc/reference.md's headline count is not the table underneath it").toEqual(g.headline);
  });

  /**
   * **The nine occurrences a rename will not reach, listed rather than excused.**
   * `points at` in the installer is the English verb, and the same spelling in
   * `lingtai.ts` is the `end` point sixty-nine lines away — so no exemption row can
   * separate them, and none tries. What this table does is tell `#233` that its
   * `0 occurrences in 0 files` costs nine reworded sentences on top of the
   * renames, and what this case does is stop the table saying it about a row the
   * ledger does not carry.
   *
   * **And the nine is the document's own word, not a copy kept here.** The
   * section's *9 of those …* is held to the table under it and to the allowlist
   * beside it, so rewording one of those sentences is the rows and the two
   * numbers, all four edits in `doc/reference.md` — which is what that section
   * says the ceremony is, and what a `toBe(9)` in this file would have made a
   * lie of on the first ticket that did it.
   */
  it("names the English occurrences against rows the allowlist really carries", async () => {
    const g = await glossary();

    expect(english(g), "doc/reference.md's English table and its allowlist disagree").toEqual([]);
  });
});
