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
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * The allowlist's ceiling, and the only number in this file that is not read
 * from the document. **It may be lowered and never raised**: lowering it is what
 * a rename ticket earns, raising it is the sentence *align the terms* becoming
 * untrue one row at a time.
 */
const MAY_NOT_EXCEED = 345;

/** `GatesResolved` → `gates` · `resolved`; `checkpoint` → `checkpoint`, one word and safe. */
function words(token: string): string[] {
  return (token.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g) ?? []).map((w) => w.toLowerCase());
}

/**
 * A source file split into what the rule reads and what it does not.
 *
 * Comments come out, because **nothing mechanical can tell a comment about the
 * past from a comment about the present** — 0018's *the point called `diff`* is
 * correct and must keep its word. What is left is the code (identifiers, types,
 * event types, recipe keys, and JSX text, which is copy a person reads) and the
 * contents of every string literal, which is the board's copy, a refusal's text
 * and `lingtai`'s output.
 *
 * A template hole is code rather than text, and both sides get a space around
 * it so that `` `review${n}gates` `` never reads as one token.
 */
function scannable(src: string): string {
  let code = "";
  let text = "";
  let i = 0;
  // The last significant code character, which is how a regex literal is told
  // from a division.
  let prev = "";
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      text += " ";
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (quote === "`" && src[i] === "$" && src[i + 1] === "{") {
          let depth = 1;
          i += 2;
          const start = i;
          while (i < src.length && depth > 0) {
            if (src[i] === "{") depth++;
            else if (src[i] === "}") depth--;
            if (depth > 0) i++;
          }
          code += ` ${src.slice(start, i)} `;
          text += " ";
          i++;
          continue;
        }
        text += src[i];
        i++;
      }
      i++;
      text += " ";
      prev = "x";
      continue;
    }
    if (c === "/" && !/[A-Za-z0-9_$)\]]/.test(prev)) {
      i++;
      while (i < src.length && src[i] !== "/") {
        if (src[i] === "\\") i++;
        else if (src[i] === "[") while (i < src.length && src[i] !== "]") i += src[i] === "\\" ? 2 : 1;
        i++;
      }
      i++;
      while (i < src.length && /[a-z]/.test(src[i]!)) i++;
      prev = "x";
      continue;
    }
    code += c;
    if (!/\s/.test(c!)) prev = c!;
    i++;
  }
  return `${code}\n${text}`;
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
    for (const token of scannable(await readFile(`${root}${file}`, "utf8")).match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []) {
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
   * 2026-09-23; a 346th entry is red whether it arrived as a new name in `src/`
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
