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
 * one home for the allowlist, and it is that document. **The single exception is
 * `MEASURED` below, and it is a ratchet rather than a second home**: a frozen
 * copy of the debt as it was measured, which a document that an author edits in
 * the same motion cannot be.
 *
 * **This ticket renames nothing.** It records what is still wrong and bounds it:
 * every violation has a row, a row with nothing behind it is as red as a
 * violation with no row, and `MEASURED` below refuses any `(file, token)` pair
 * the measurement did not hold. So a ticket that renames its area deletes its
 * rows and needs no ceremony, and a ticket that would widen the debt cannot do
 * it quietly — not by adding a name, and not by swapping one name for another
 * and leaving the count where it found it.
 *
 * **Whole words inside a token, never substrings.** `checkpoint` (55),
 * `checkpoints` (34), `pointer` (17) and `pointed` (29) occurrences of the
 * source text are the projector's and the installer's own vocabulary and have
 * nothing to do with a step; a substring ban on `point` — a grep, which is what
 * anybody reaches for first — destroys all four. *does not reach inside a word*
 * below is the test that says so, and it is the reason the document holds a list
 * of words rather than a regex. Three of the four are also names the **rule**
 * reads; `pointer` is not, because all 17 of its occurrences are comments, and
 * that test says which is which — a guard that asserts a live subject over text
 * the rule never sees asserts nothing.
 */
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * **The debt as it was measured, pair by pair, and the only copy of it that is
 * not read from the document.** This is the ratchet, and it is a set rather than
 * a count because a count is not one. Two ordinary sequences walk straight past
 * a total. A **swap inside one file**: `packages/conductor/src/filter.ts` reads
 * `` GatePlan · gatePlan · gates · point ``, a ticket renames that `point` and
 * introduces a `gateStep` in the same diff, the row becomes
 * `` GatePlan · gatePlan · gateStep · gates `` and the total is still 340 — a
 * retired name added with nothing red. And **after any shrink**: rename the
 * `actions` package away, its seven rows and 81 entries go with it, and a
 * hand-written 340 is 81 entries of slack that brand-new names arrive in one at a
 * time, each of them red on the equality below and made green again by the row
 * somebody adds to pass it.
 *
 * So the rule is per `(file, token)` pair: **the allowlist may hold nothing this
 * table does not.** Deleting a row stays free and touches only the document —
 * that is what a rename ticket earns. Widening the debt is not a row in
 * `doc/reference.md` any more, it is an edit here, where the word *measured* and
 * the date say what it costs.
 *
 * Pruning this table as rows go is housekeeping and nothing depends on it; the
 * one thing it may never do is grow.
 */
const MEASURED: Readonly<Record<string, string>> = {
  "apps/board/src/app/backlog/page.tsx": "gate",
  "apps/board/src/app/evidence.tsx": "GateEvidence gate gates",
  "apps/board/src/app/page.tsx": "gate gatesApproved gatesFailed gatesPassed gatesWaived points",
  "apps/board/src/app/plan.tsx": "point points",
  "apps/board/src/app/rail.tsx": "PointProgress PointState point pointOf points",
  "apps/board/src/app/recipe/[project]/page.tsx": "point",
  "apps/board/src/app/setup/wizard/finish.ts": "wholeGates",
  "apps/board/src/app/setup/wizard/wizard.tsx": "gates",
  "apps/board/src/app/standing.tsx": "gate",
  "apps/board/src/app/task/[id]/page.tsx": "gate gates point points",
  "apps/board/src/lib/board.ts": "GatePlan gates gatesApproved gatesFailed gatesPassed gatesWaived",
  "apps/board/src/lib/history.ts": "GateDidNotFinish GateFailed GateNeverRan GatePassed GateRequested GateStarted GateWaived GatesResolved gate gateAt points",
  "apps/board/src/lib/progress.ts": "GateDidNotFinish GateFailed GateNeverRan GatePassed GatePlan GateRequested GateStarted GateWaived GatesResolved PointProgress PointState gate point pointOf points",
  "apps/board/src/lib/queued.ts": "GatePlan PlannedPoint point points",
  "apps/board/src/lib/recipe.ts": "GateAction GatesResolved gates point points",
  "apps/board/src/lib/task.ts": "GateDidNotFinish GateFailed GateNeverRan GatePassed GatePlan GateRequested GateStarted GateVerdict GateWaived GatesResolved gate gates",
  "apps/cli/src/backlog.ts": "gate",
  "apps/cli/src/conduct.ts": "gate",
  "apps/cli/src/doctor.ts": "GatesResolved endPointRan gate gates point points",
  "apps/cli/src/end.ts": "gates",
  "apps/cli/src/install.ts": "points",
  "apps/cli/src/lingtai.ts": "gate gates point",
  "apps/cli/src/restart.ts": "gates",
  "apps/cli/src/service.ts": "gates point",
  "apps/cli/src/status.ts": "gates",
  "apps/site/src/lib/snapshot.ts": "gates",
  "packages/actions/src/agent-gate.ts": "AgentGateDeps AgentGateSpec Gate GateContext GateFinding GateResult createAgentGate gate point",
  "packages/actions/src/from-recipe.ts": "AgentGateDeps Gate GateAction GateActionUnavailableError GateDeps WatchGateDeps createAgentGate createHumanGate createProcessGate createWatchGate gate gates gatesFromRecipe point wrongPoint",
  "packages/actions/src/gate.ts": "Gate GateContext GateDidNotFinish GateEvent GateFailed GateFinding GateNeverRan GatePassed GateRequested GateResult GateStarted GateVerdict gate gates point runGatePipeline",
  "packages/actions/src/human-gate.ts": "Gate GateContext GateResult HumanGateSpec createHumanGate gate",
  "packages/actions/src/index.ts": "AgentGateDeps AgentGateSpec Gate GateActionUnavailableError GateContext GateDeps GateEvent GateFinding GateResult GateVerdict HumanGateSpec ProcessGateSpec WatchGateDeps WatchGateSpec createAgentGate createHumanGate createProcessGate createWatchGate gate gatesFromRecipe runGatePipeline",
  "packages/actions/src/process-gate.ts": "Gate GateContext GateResult ProcessGateSpec createProcessGate gate",
  "packages/actions/src/watch-gate.ts": "Gate GateContext GateResult WatchGateDeps WatchGateSpec createWatchGate gate gates",
  "packages/conductor/src/approve.ts": "GateAction GateWaived GatesResolved gate gates gatesPassed point points splitGate",
  "packages/conductor/src/attempts.ts": "GateDidNotFinish GateFailed GateNeverRan GatePassed GateStarted GateWaived gate",
  "packages/conductor/src/attribution.ts": "gate",
  "packages/conductor/src/backlog.ts": "gate",
  "packages/conductor/src/close.ts": "GateAction gates point",
  "packages/conductor/src/create-app.ts": "point",
  "packages/conductor/src/end-point.ts": "GateAction",
  "packages/conductor/src/filter.ts": "GatePlan gatePlan gates point",
  "packages/conductor/src/fix.ts": "GateFinding gates point",
  "packages/conductor/src/gate-audit.ts": "GateDidNotFinish GateFailed GateNeverRan GatePassed GateRequested GateStarted GateWaived gate point points",
  "packages/conductor/src/gates-resolved.ts": "gate gates gatesResolved points",
  "packages/conductor/src/index.ts": "GatePlan gate gatePlan point",
  "packages/conductor/src/labels.ts": "gates",
  "packages/conductor/src/never-started.ts": "gate",
  "packages/conductor/src/onboard.ts": "gates point",
  "packages/conductor/src/run-once.ts": "GateFinding GatesResolved gate gateDeps gateDetail gateDidNotFinish gates gatesFromRecipe gatesPassed gatesResolved gitForGates point runGatePipeline",
  "packages/conductor/src/schedule.ts": "gate",
  "packages/conductor/src/wizard-page.ts": "GateAction gates wholeGates",
  "packages/conductor/src/wizard.ts": "gates",
  "packages/daemon/src/control.ts": "gates",
  "packages/daemon/src/converge.ts": "point",
  "packages/domain/src/backlog.ts": "gate",
  "packages/domain/src/events.ts": "GateDidNotFinish GateFailed GateNeverRan GatePassed GateRequested GateStarted GateWaived GatesResolved gate gateBase points",
  "packages/domain/src/run.ts": "GateDidNotFinish GateFailed GateFinding GateNeverRan GatePassed GateRequested GateStarted GateState GateVerdict GateWaived gate gates gatesOn withGate",
  "packages/domain/src/streams.ts": "gates",
  "packages/domain/src/upcast.ts": "GateFailed GatePassed GateRequested GateStarted GateWaived GatesResolved gate gatePointRenamed points",
  "packages/env/src/colour.ts": "gates",
  "packages/env/src/index.ts": "Point",
  "packages/event-store/src/index.ts": "PointNeverRan",
  "packages/event-store/src/log.ts": "PointNeverRan",
  "packages/event-store/src/queries.ts": "GatesResolved PointNeverRan gate point points",
  "packages/event-store/src/sqlite.ts": "GatesResolved gate point points",
  "packages/projector/src/backlog.ts": "GatePassed gate",
  "packages/projector/src/postgres.ts": "gate gates gatesApproved gatesFailed gatesPassed gatesWaived",
  "packages/projector/src/sqlite.ts": "gate gates gatesApproved gatesFailed gatesPassed gatesWaived",
  "packages/projector/src/task-view.ts": "GateDidNotFinish GateFailed GateNeverRan GatePassed GateWaived gate gates gatesApproved gatesFailed gatesPassed gatesWaived point setGate",
  "packages/recipe/src/local.ts": "gates gatesRefusal point",
  "packages/recipe/src/presets.ts": "gates",
  "packages/recipe/src/propose.ts": "gates",
  "packages/recipe/src/recipe.ts": "GateAction GateMap GatesResolved gates point",
  "packages/recipe/src/resolve.ts": "gates",
  "packages/recipe/src/watch.ts": "gate",
  "packages/repo/src/integrate.ts": "gate gateDetail gatesPassed",
};

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

    // And live **to the rule**, not to a grep. Asserting this against the raw
    // file text is the mistake to make here: all 17 of `pointer`'s occurrences
    // are comments — `standing.tsx:63`, `latch.tsx:89`,
    // `task/[id]/page.tsx:139` — and the rule reads no comment, so a text guard
    // reports a subject the matcher can never be handed and stays green with
    // every `pointer` identifier in the repository renamed away. `pointer` is
    // therefore a shape case, asserted above and nowhere else; the other three
    // are names `src/` really hands over, and this is what says so.
    const read = new Set(
      (await Promise.all((await sources()).map(async (f) => tokens(await readFile(`${root}${f}`, "utf8"), f)))).flat(),
    );

    for (const token of ["checkpoint", "checkpoints", "pointed"]) {
      expect(read.has(token), `the rule reads no ${token} in src/ — this case has gone stale`).toBe(true);
    }
    expect(read.has("pointer"), "`pointer` is a token the rule reads now — it has a live subject and belongs above").toBe(false);
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
   * And it may only shrink, **pair by pair rather than in total**. A retired name
   * arriving in `src/` is red on the equality above until somebody edits the
   * allowlist to match it, and red here afterwards: `MEASURED` is what the debt
   * *was*, so a pair that is not in it is a pair being added — whether it arrived
   * as a new file, as a new token in an old file, or as a swap that left the
   * count where it found it. Removing entries is free, which is the whole point.
   */
  it("may only shrink", async () => {
    const g = await glossary();

    const added = [...g.allowlist]
      .flatMap(([file, tokens]) => {
        const measured = new Set((MEASURED[file] ?? "").split(" ").filter((t) => t.length > 0));
        return tokens.filter((t) => !measured.has(t)).map((t) => `${file} · ${t}`);
      })
      .sort();

    expect(added, "the allowlist has grown — a retired name may not be added to the debt").toEqual([]);
    expect(g.allowlist.size).toBeGreaterThan(0);
  });

  /**
   * **And the section's own headline is one of the things that may not drift.**
   * `340 entries in 76 files` is what `#233` sizes the remaining debt from, and it
   * is what a rename ticket makes wrong by deleting rows: take the `projector`
   * and `event-store` rows away — eight of them, 38 entries — and nothing parsed
   * that sentence, so both tests above stayed green while the headline said 340 in
   * 76 and the table underneath it came to 302 in 68. It is counted here rather
   * than remembered, so correcting it is part of deleting a row.
   */
  it("says how big it is, and that sentence is counted rather than remembered", async () => {
    const g = await glossary();
    const entries = [...g.allowlist.values()].reduce((n, tokens) => n + tokens.length, 0);

    expect(
      { entries, files: g.allowlist.size },
      "doc/reference.md's headline count is not the table underneath it",
    ).toEqual(g.headline);
  });
});
