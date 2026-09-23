/**
 * **One glossary of retired names, and a list that may only shrink** (`#232`).
 *
 * The pipeline epic renames the vocabulary over several tickets, and a rename
 * spread over several tickets ends as two vocabularies for one thing — which is
 * the defect [0058](../../../doc/decisions/0058-lingtai-is-a-development-pipeline.md)
 * §Context was written about. Before this file nothing could tell whether a
 * name in `src/` was current or left over.
 *
 * **The list is read from `doc/reference.md`, not copied here** — the same rule
 * `doc/tamper-watch.md` and `packages/actions/unit/tamper-watch.test.ts` follow,
 * and 0059 §5's *the document cannot drift from the code without a red test* a
 * third time. There is one home for the words, one home for the exemptions and
 * one home for the allowlist, and it is that document.
 *
 * **This ticket renames nothing.** It records what is still wrong and bounds it:
 * every violation has a row, a row with nothing behind it is as red as a
 * violation with no row, and `MAY_NOT_EXCEED` below refuses a longer list than
 * the one that was measured. So a ticket that renames its area deletes its rows
 * and needs no ceremony, and a ticket that would widen the debt cannot do it
 * quietly.
 *
 * **Whole words inside a token, never substrings.** `checkpoint` (55),
 * `checkpoints` (34), `pointer` (17) and `pointed` (29) are the projector's and
 * the installer's own vocabulary and have nothing to do with a step; a substring
 * ban on `point` destroys all four. *does not reach inside a word* below is the
 * test that says so, and it is the reason the document holds a list of words
 * rather than a regex.
 */
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * The allowlist's ceiling, and the only number in this file that is not read
 * from the document. **It may be lowered and never raised**: lowering it is what
 * a rename ticket earns, raising it is the sentence *align the terms* becoming
 * untrue one row at a time.
 */
const MAY_NOT_EXCEED = 340;

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

/** `doc/reference.md`'s `## retired name` section, subsection by subsection. */
async function glossary() {
  const doc = await readFile(`${root}doc/reference.md`, "utf8");
  const start = doc.indexOf("\n## retired name");
  expect(start, "doc/reference.md has no `## retired name` section — the glossary has no home").toBeGreaterThan(0);
  const body = doc.slice(start + 1);
  const section = body.slice(0, body.indexOf("\n## ", 1));

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
  return {
    /** The four lowercase words, matched inside any token. */
    retired: glossaryRows.filter((r) => /^[a-z]+$/.test(r[0]!)).map((r) => r[0]!),
    /** `GatePoint` → `Step` and `GateAction` → `Plugin`: a replacement the word rules do not give. */
    named: glossaryRows.filter((r) => !/^[a-z]+$/.test(r[0]!)).map((r) => [r[0]!, r[1]!] as const),
    /** Tokens that carry one of the words and are not the retired concept. */
    exempt: rows("not the retired name").map((r) => r[0]!),
    /** file → every retired token still in it. */
    allowlist: new Map(rows("the allowlist").map((r) => [r[0]!, r[1]!.split("·").map((t) => t.trim().replace(/`/g, ""))])),
  };
}

/** What `src/` actually says today: file → the retired tokens in it, sorted. */
async function violations(g: Awaited<ReturnType<typeof glossary>>) {
  const retired = new Set(g.retired);
  const exempt = new Set(g.exempt);
  const found = new Map<string, string[]>();
  for (const file of await sources()) {
    const hit = new Set<string>();
    for (const token of tokens(await readFile(`${root}${file}`, "utf8"), file)) {
      if (exempt.has(token)) continue;
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
    const exempt = new Set(g.exempt);
    const innocent = ["checkpoint", "checkpoints", "pointer", "pointed"];

    for (const token of innocent) {
      expect(words(token), `${token} was split into pieces`).toEqual([token]);
      expect(words(token).some((w) => retired.has(w)), `${token} is flagged`).toBe(false);
      // And not by being excused, which would be a weaker guarantee: an
      // exemption is a judgement somebody has to keep making, and the shape of
      // the match is not.
      expect(exempt.has(token), `${token} needs no exemption — whole-word matching already leaves it alone`).toBe(false);
    }

    const everything = (await Promise.all((await sources()).map((f) => readFile(`${root}${f}`, "utf8")))).join("\n");
    for (const token of innocent) {
      expect(new RegExp(`\\b${token}\\b`, "i").test(everything), `no ${token} in src/ — this case has gone stale`).toBe(true);
    }
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

    expect(Object.fromEntries([...found].sort()), "doc/reference.md's allowlist and src/ disagree").toEqual(
      Object.fromEntries([...g.allowlist].sort()),
    );
  });

  /**
   * And it may only shrink. `MAY_NOT_EXCEED` is the count measured on
   * 2026-09-23; a 341st entry is red whether it arrived as a new name in `src/`
   * or as a row somebody added to make one green. Removing entries is free.
   */
  it("may only shrink", async () => {
    const g = await glossary();
    const entries = [...g.allowlist.values()].reduce((n, tokens) => n + tokens.length, 0);

    expect(entries, "the allowlist has grown — a retired name may not be added to the debt").toBeLessThanOrEqual(
      MAY_NOT_EXCEED,
    );
    expect(g.allowlist.size).toBeGreaterThan(0);
  });
});
