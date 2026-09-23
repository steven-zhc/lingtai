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
 * decide it.** The four words are pinned here and so are the two exemptions,
 * because either one makes a retired name green by writing a row and moves no
 * count while doing it: a word taken off the list stops being matched, and an
 * exemption skips the match outright, everywhere. What the document decides on
 * its own is the allowlist — the one table whose every row is checked against
 * `src/`, and whose size is checked against the sentence above it.
 *
 * **This ticket renames nothing.** It records what is still wrong and makes it
 * countable: every violation has a row, and **a row with nothing behind it is as
 * red as a violation with no row**. So a ticket that renames its area deletes
 * its rows and corrects one number, and a ticket that would widen the debt
 * cannot do it out of sight — the name needs a row, and the row makes that
 * number wrong until it is raised, on a line that says what it is counting.
 * Whether it should have been raised is a reading, and belongs to the review
 * rather than to this file.
 *
 * **Whole words inside a token, never substrings.** `checkpoint` (55),
 * `checkpoints` (34), `pointer` (17) and `pointed` (29) occurrences of the
 * source text are the projector's and the installer's own vocabulary and have
 * nothing to do with a step; a substring ban on `point` — a grep, which is what
 * anybody reaches for first — destroys all four. *does not reach inside a word*
 * below is the test that says so, and it is the reason the document holds a list
 * of words rather than a regex. Three of the four are also names the **rule**
 * reads, and that test says so, because a guard that asserts a live subject over
 * text the rule never sees asserts nothing. `pointer` is not one of them today —
 * all 17 of its occurrences are comments — and **that is a fact about `src/` and
 * not a rule, so nothing asserts it either way**: `cursor: "pointer"` in a
 * component makes it live, and a guard reading *the rule sees no `pointer`* is a
 * red `build` gate on a diff that introduces no retired name. What holds for all
 * four, live or not, is that the rule does not flag them, and that is what is
 * asserted over everything `src/` hands over.
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

/** Every identifier-shaped token the rule reads out of one file, in order. */
function tokens(src: string, name: string): string[] {
  return scannable(src, name).match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
}

/** Everything under `{apps,packages}/*<!---->/src/`, and nothing under `doc/`. */
async function sources(): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await walk(path);
      else if (/\.tsx?$/.test(entry.name)) found.push(path.slice(root.length));
    }
  };
  for (const parent of ["apps", "packages"]) {
    for (const name of (await readdir(`${root}${parent}`)).sort()) {
      await walk(`${root}${parent}/${name}/src`).catch(() => {});
    }
  }
  return found.sort();
}

/**
 * One markdown document's `## retired name` section, subsection by subsection.
 *
 * **It takes the text rather than reading the file**, so that *the ledger* below
 * can hand it a section it wrote — a row added, a row deleted, a file moved, an
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

  const glossaryRows = rows("the words");
  // The allowlist's headline sentence, which is prose and not a row, and so is
  // the one number in the section that could once say anything at all.
  const headline = /\*\*(\d+) entries in (\d+) files/.exec(section);
  expect(headline, "doc/reference.md's allowlist does not say how big it is").not.toBeNull();
  return {
    /** What the section's own sentence claims the table below it comes to. */
    headline: { entries: Number(headline![1]), files: Number(headline![2]) },
    /** The four lowercase words, matched inside any token. */
    retired: glossaryRows.filter((r) => /^[a-z]+$/.test(r[0]!)).map((r) => r[0]!),
    /** `GatePoint` → `Step` and `GateAction` → `Plugin`: a replacement the word rules do not give. */
    named: glossaryRows.filter((r) => !/^[a-z]+$/.test(r[0]!)).map((r) => [r[0]!, r[1]!] as const),
    /**
     * Tokens that carry one of the words and are not the retired concept, each
     * with **the one file it is excused in**. A bare token would excuse the
     * same spelling in all 216 of them.
     */
    exempt: rows("not the retired name").map((r) => [r[0]!, r[1]!] as const),
    /** file → every retired token still in it. */
    allowlist: new Map(rows("the allowlist").map((r) => [r[0]!, r[1]!.split("·").map((t) => t.trim().replace(/`/g, ""))])),
  };
}

/** The real one, which is `doc/reference.md` and nowhere else. */
async function glossary() {
  return parse(await readFile(`${root}doc/reference.md`, "utf8"));
}

/**
 * **The two ways the ledger and `src/` can disagree, and there are only two.**
 * `unrecorded` is a retired name with no row — debt that arrived without being
 * written down. `stale` is a row with nothing behind it — a rename that landed
 * and left its ledger standing, which is how *align the terms* ends as a
 * sentence everybody agrees with and the last ticket discovers is untrue.
 *
 * Both are red, and that is what makes the table the debt rather than a bound on
 * it. A file that moves shows up as one of each, naming the path to delete and
 * the path to add — two edits to the document a person is already reading, and
 * to nothing else.
 */
function disagreement(found: ReadonlyMap<string, string[]>, allowlist: ReadonlyMap<string, string[]>) {
  const pairs = (table: ReadonlyMap<string, string[]>) =>
    new Set([...table].flatMap(([file, ours]) => ours.map((token) => `${file} · ${token}`)));
  const real = pairs(found);
  const recorded = pairs(allowlist);

  return {
    unrecorded: [...real].filter((pair) => !recorded.has(pair)).sort(),
    stale: [...recorded].filter((pair) => !real.has(pair)).sort(),
  };
}

/** What a table of `file → retired tokens` comes to, as the document says it. */
function size(allowlist: ReadonlyMap<string, string[]>) {
  return { entries: [...allowlist.values()].reduce((n, ours) => n + ours.length, 0), files: allowlist.size };
}

/** What `src/` actually says today: file → the retired tokens in it, sorted. */
async function violations(g: ReturnType<typeof parse>) {
  const retired = new Set(g.retired);
  const exempt = new Set(g.exempt.map(([token, file]) => `${file} · ${token}`));
  const found = new Map<string, string[]>();
  for (const file of await sources()) {
    const hit = new Set<string>();
    for (const token of tokens(await readFile(`${root}${file}`, "utf8"), file)) {
      if (exempt.has(`${file} · ${token}`)) continue;
      if (words(token).some((w) => retired.has(w))) hit.add(token);
    }
    if (hit.size > 0) found.set(file, [...hit].sort());
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
   * **The other door, and it is bolted differently.** An exemption is not a row
   * in a ledger, it is a `continue` before the match — so one row added here
   * excuses its token everywhere at once and nothing underneath it moves: the
   * allowlist does not grow, the headline is unchanged, and a brand-new retired
   * name is green in all 216 files at once. It is the one edit to that section a
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
   * And the file column is the rule and not a note: `pointShim` is the English
   * verb **in `install.ts`**, and a `pointShim` somewhere else is a token
   * nobody reviewed.
   */
  it("excuses a token only in the file the document names", async () => {
    const g = await glossary();
    const elsewhere = { ...g, exempt: g.exempt.filter(([, file]) => file !== "apps/cli/src/install.ts") };

    expect((await violations(g)).get("apps/cli/src/install.ts"), "pointShim is excused in install.ts").toEqual(["points"]);
    expect(
      (await violations(elsewhere)).get("apps/cli/src/install.ts"),
      "the same token, read in a file the document does not excuse it in",
    ).toEqual(["pointShim", "points"]);
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
   * Asserted against the real matcher rather than against a list, and asserted
   * live: each one is in `src/` today, so this is a case rather than a claim.
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
    }

    // And live **to the rule**, not to a grep. Asserting a live subject against
    // the raw file text is the mistake to make here: the rule reads no comment,
    // so a text guard reports a subject the matcher can never be handed and
    // stays green with every one of these identifiers renamed away.
    const read = new Set(
      (await Promise.all((await sources()).map(async (f) => tokens(await readFile(`${root}${f}`, "utf8"), f)))).flat(),
    );

    for (const token of ["checkpoint", "checkpoints", "pointed"]) {
      expect(read.has(token), `the rule reads no ${token} in src/ — this case has gone stale`).toBe(true);
    }

    // `pointer` is the fourth, and it is **not** in that loop: all 17 of its
    // occurrences are comments today — `standing.tsx:63`, `latch.tsx:89`,
    // `task/[id]/page.tsx:139` — and the rule reads none of them. Which way
    // round that goes is a fact about `src/` and not a rule, so neither
    // direction is asserted: written the other way, as *the rule reads no
    // `pointer`*, a `style={{ cursor: "pointer" }}` added to a component is a
    // red `build` gate on a diff that introduces no retired name, with no action
    // in the failure a reader could take. What is true of all four whether they
    // are live or not is that nothing flags them, and that is asserted here over
    // every file, through the rule a violation really goes through — exemptions
    // and all.
    const flagged = [...(await violations(g))].flatMap(([file, found]) =>
      found.filter((t) => innocent.includes(t)).map((t) => `${file} · ${t}`),
    );

    expect(flagged, "a word that was never ours was flagged as a retired name").toEqual([]);
  });

  it("reads the list from doc/reference.md and enforces it nowhere in doc/", async () => {
    const files = await sources();

    expect(files.length).toBeGreaterThan(100);
    expect(files.filter((f) => f.startsWith("doc/"))).toEqual([]);
    expect(files.every((f) => /^(apps|packages)\/[^/]+\/src\//.test(f))).toBe(true);
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
});

/**
 * **What the ledger refuses, as cases rather than as today's document agreeing
 * with today's `src/`.** Both are correct as this lands, so *is exactly what
 * src/ says today* below is green whatever the rule does; these are what say it
 * is green for a reason. Each case writes a `## retired name` section, parses it
 * with the same parser the document goes through, and reads it against a `src/`
 * it states — so *adding a row is red* is asserted rather than described.
 */
describe("the ledger", () => {
  /** A section with the headline and the rows a case wants, and nothing else. */
  const written = (headline: string, rows: string[]) =>
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
        "## the next term",
        "",
      ].join("\n"),
    );

  const filter = "packages/conductor/src/filter.ts";
  const src = new Map([[filter, ["GatePlan", "gatePlan", "gates", "point"]]]);
  const row = (file: string, ours: string) => `| \`${file}\` | ${ours} |`;
  const four = "`GatePlan` · `gatePlan` · `gates` · `point`";

  it("passes when the table is what src/ says", () => {
    expect(disagreement(src, written("4 entries in 1 files", [row(filter, four)]).allowlist)).toEqual({
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
    const added = written("5 entries in 2 files", [row(filter, four), row("packages/conductor/src/close.ts", "`gates`")]);

    expect(disagreement(src, added.allowlist).stale).toEqual(["packages/conductor/src/close.ts · gates"]);
  });

  /** And the other direction: a name that arrived and was not written down. */
  it("reds a retired name that no row records", () => {
    const arrived = new Map([[filter, [...src.get(filter)!, "gateStep"].sort()]]);

    expect(disagreement(arrived, written("4 entries in 1 files", [row(filter, four)]).allowlist).unrecorded).toEqual([
      `${filter} · gateStep`,
    ]);
  });

  /**
   * **Deleting a row is free, and that is the half a rename ticket lives on.**
   * The name went, the row goes with it, and nothing else is edited — no second
   * table, no baseline, no ceremony beyond the number above.
   */
  it("passes when a row goes because the name went", () => {
    const close = "packages/conductor/src/close.ts";
    const before = new Map([...src, [close, ["gates"]]]);
    const both = written("5 entries in 2 files", [row(filter, four), row(close, "`gates`")]);
    // `close.ts`'s `gates` renamed away: its row goes, the other stays.
    const after = written("4 entries in 1 files", [row(filter, four)]);

    expect(disagreement(before, both.allowlist)).toEqual({ unrecorded: [], stale: [] });
    expect(disagreement(src, after.allowlist)).toEqual({ unrecorded: [], stale: [] });
  });

  /** Deleting a row the name is still behind is the debt it still is. */
  it("reds a row deleted while the name stays", () => {
    expect(disagreement(src, written("3 entries in 1 files", [row(filter, "`GatePlan` · `gatePlan` · `gates`")]).allowlist)).toEqual(
      { unrecorded: [`${filter} · point`], stale: [] },
    );
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
    const moved = new Map([[to, src.get(filter)!]]);
    const ours = ["GatePlan", "gatePlan", "gates", "point"];

    expect(disagreement(moved, written("4 entries in 1 files", [row(filter, four)]).allowlist)).toEqual({
      unrecorded: ours.map((token) => `${to} · ${token}`),
      stale: ours.map((token) => `${filter} · ${token}`),
    });
    // And the edit the failure asks for is that row's path, in the document.
    expect(disagreement(moved, written("4 entries in 1 files", [row(to, four)]).allowlist)).toEqual({
      unrecorded: [],
      stale: [],
    });
  });

  /**
   * **`0 entries in 0 files` is a state this passes, not one it refuses** — it
   * is `#233`'s acceptance, and a lower bound under the table would red the
   * `build` gate on the diff that finishes the epic. Nothing guards against an
   * empty parse either, because nothing has to: while `src/` still carries debt
   * an empty table is red on the rule above, and when it carries none an empty
   * table is the truth.
   */
  it("passes on the empty allowlist #233 is aiming at", () => {
    const empty = written("0 entries in 0 files", []);

    expect(empty.allowlist.size).toBe(0);
    expect(size(empty.allowlist)).toEqual(empty.headline);
    expect(disagreement(new Map(), empty.allowlist)).toEqual({ unrecorded: [], stale: [] });
  });

  /**
   * **And the headline is the number a review reads the direction off.** The
   * test cannot tell a retired name that had to arrive from one that did not —
   * nothing can — so what it does is make that sentence true: a row added or
   * deleted without correcting it is red, and raising it is one line in a diff,
   * saying what it is counting.
   */
  it("counts the table rather than reading the sentence above it", () => {
    const left = written("340 entries in 76 files", [row(filter, four)]);

    expect(left.headline, "the sentence, as the document says it").toEqual({ entries: 340, files: 76 });
    expect(size(left.allowlist), "the table, counted — and what the document is held to").toEqual({ entries: 4, files: 1 });
  });
});

describe("the allowlist", () => {
  /**
   * The whole ticket, in one assertion, and it is an equality rather than a
   * subset on purpose. A violation with no row is new debt; **a row with no
   * violation is a rename that landed and left its ledger behind**, which is how
   * *align the terms* becomes a sentence everybody agrees with and the last
   * ticket discovers is untrue.
   */
  it("is exactly what src/ says today", async () => {
    const g = await glossary();
    const found = await violations(g);

    expect(
      disagreement(found, g.allowlist),
      "doc/reference.md's allowlist and src/ disagree — `unrecorded` is debt with no row, `stale` is a row with nothing behind it",
    ).toEqual({ unrecorded: [], stale: [] });
  });

  /**
   * **And the section's own headline is the other thing that may not drift.**
   * `340 entries in 76 files` is what `#233` sizes the remaining debt from, and
   * it is what a rename ticket makes wrong by deleting rows: take the
   * `projector` and `event-store` rows away — eight of them, 38 entries — and
   * nothing parsed that sentence, so the equality above stayed green while the
   * headline said 340 in 76 and the table underneath it came to 302 in 68. It is
   * counted here rather than remembered, so correcting it is part of deleting a
   * row — and part of adding one.
   */
  it("says how big it is, and that sentence is counted rather than remembered", async () => {
    const g = await glossary();

    expect(size(g.allowlist), "doc/reference.md's headline count is not the table underneath it").toEqual(g.headline);
  });
});
