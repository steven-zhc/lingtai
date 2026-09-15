/**
 * Writing a recipe down: a new one with its reasons in it, and an edit to one
 * that keeps the reasons somebody else wrote (#162).
 *
 * **`parse` is fine for reading. It is `stringify` that must never touch a file
 * a person has edited.** Parsing this repository's own recipe to an object and
 * stringifying it back destroys 74 of its 503 lines — every comment — and those
 * comments are the reason anybody dares change the file.
 *
 * `parseDocument` + `setIn` keeps the comments, and is not enough on its own:
 * `Document.toString()` re-renders the whole file, and on this repository's
 * recipe that drops a blank line and re-indents the sixteen-line comment above
 * `merge:` even with nothing changed. So `setIn` decides what the file must
 * *mean*, and the text is the original with only the changed nodes' source
 * ranges spliced — everything else is the person's bytes, not a rendering of
 * them. The result is read back and compared with `setIn`'s answer, so an edit
 * this cannot make surgically throws rather than writing something else.
 */
import { isDeepStrictEqual } from "node:util";
import {
  Document,
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseDocument,
  Scalar,
  type Node,
  type Pair,
  type YAMLMap,
  type YAMLSeq,
} from "yaml";
import { Recipe } from "./recipe.ts";

/**
 * The sentences the wizard showed, by the dotted path of the block each one is
 * about — `{ "source.kinds": "order is priority" }`. The same words the person
 * just read, so a generated file does not carry a second explanation of a field.
 */
export type Said = Readonly<Record<string, string>>;

/** One field set to a value. `undefined` removes it. */
export interface RecipeChange {
  path: readonly (string | number)[];
  value: unknown;
}

const RENDER = { lineWidth: 0, flowCollectionPadding: false } as const;
const COMMENT_WIDTH = 78;

/** A new recipe file, with a comment above every block in `said`. */
export function emitRecipe(recipe: Recipe, said: Said = {}): string {
  const doc = new Document(Recipe.parse(recipe));
  const root = doc.contents as YAMLMap;
  root.items.forEach((pair, i) => {
    if (i > 0) (pair.key as Node).spaceBefore = true;
  });
  for (const [dotted, sentence] of Object.entries(said)) {
    const path = dotted.split(".");
    const parent = path.length === 1 ? root : doc.getIn(path.slice(0, -1), true);
    const pair = isMap(parent) ? findPair(parent, path[path.length - 1]!) : undefined;
    // A sentence with nowhere to go is a reason the file silently lost.
    if (!pair) throw new Error(`said names "${dotted}", which the recipe does not have`);
    const indent = 2 * (path.length - 1);
    (pair.key as Node).commentBefore = wrap(sentence, COMMENT_WIDTH - indent - 2)
      .map((line) => (line === "" ? "" : ` ${line}`))
      .join("\n");
  }
  return doc.toString(RENDER);
}

/**
 * The same file with `changes` made, and every other byte as it was.
 *
 * Throws if the file does not parse, if the edited recipe does not pass
 * `Recipe.parse`, or if the splice would not read back as the change asked for.
 */
export function editRecipe(existing: string, changes: readonly RecipeChange[]): string {
  const doc = parseDocument(existing);
  if (doc.errors.length > 0) throw new Error(`the recipe does not parse: ${doc.errors[0]!.message}`);

  // What the file must mean afterwards — `setIn`'s answer, never its rendering.
  const oracle = parseDocument(existing);
  for (const { path, value } of changes) {
    if (value === undefined) oracle.deleteIn(path);
    else oracle.setIn(path, value);
  }
  const target: unknown = oracle.toJS();
  Recipe.parse(target);

  const edits: Edit[] = [];
  const splicer = new Splicer(existing, doc, edits);
  if (!isMap(doc.contents)) throw new Error("the recipe is not a mapping");
  splicer.reconcile(doc.contents, target, { inlineFrom: -1, indent: 0 });

  const out = apply(existing, edits);
  const reread = parseDocument(out);
  if (reread.errors.length > 0 || !isDeepStrictEqual(reread.toJS(), target)) {
    throw new Error(
      `the change to ${changes.map((c) => c.path.join(".")).join(", ")} could not be spliced into the file ` +
        "without re-emitting it, and re-emitting would lose its comments",
    );
  }
  return out;
}

interface Edit {
  from: number;
  to: number;
  text: string;
}

/** Where a value sits: just after its `key:` or `-`, and the column its children indent from. */
interface Site {
  inlineFrom: number;
  indent: number;
}

class Splicer {
  private readonly text: string;
  private readonly doc: Document;
  private readonly edits: Edit[];

  constructor(text: string, doc: Document, edits: Edit[]) {
    this.text = text;
    this.doc = doc;
    this.edits = edits;
  }

  reconcile(node: unknown, value: unknown, site: Site): void {
    if (!isNode(node)) {
      this.replace(node, value, site);
      return;
    }
    if (isDeepStrictEqual(node.toJS(this.doc), value)) return;
    if (isMap(node) && !node.flow && isPlainObject(value)) return this.map(node, value);
    if (isSeq(node) && !node.flow && Array.isArray(value) && value.length > 0) return this.seq(node, value);
    this.replace(node, value, site);
  }

  private map(node: YAMLMap, value: Record<string, unknown>): void {
    const pairs = node.items as Pair<Node, Node | null>[];
    pairs.forEach((pair, i) => {
      const key = pair.key;
      const name = isScalar(key) ? String(key.value) : undefined;
      if (name === undefined) return;
      const keyStart = key.range![0];
      if (!(name in value)) {
        // A field goes with the comment lines directly above it, as a list item does: they are about it.
        const bound = i === 0 ? 0 : this.lineEnd(this.end(pairs[i - 1]!));
        let from = this.commentsAbove(this.lineStart(keyStart), bound);
        const to = this.lineEnd(this.end(pair));
        // A blank line on both sides of what went would leave two; take the one above.
        const blankAfter = to === this.text.length || this.text[to] === "\n";
        if (from > bound && blankAfter && this.text.slice(this.lineStart(from - 1), from).trim() === "") {
          from = this.lineStart(from - 1);
        }
        this.edits.push({ from, to, text: "" });
        return;
      }
      this.reconcile(pair.value, value[name], {
        inlineFrom: this.text.indexOf(":", key.range![1]) + 1,
        indent: this.column(keyStart),
      });
    });
    const had = new Set(pairs.map((p) => (isScalar(p.key) ? String(p.key.value) : "")));
    const added = Object.fromEntries(Object.entries(value).filter(([k]) => !had.has(k)));
    if (Object.keys(added).length > 0) {
      const last = pairs[pairs.length - 1]!;
      const at = this.lineEnd(this.end(last));
      this.edits.push({ from: at, to: at, text: this.block(added, this.column(last.key.range![0])) });
    }
  }

  private seq(node: YAMLSeq, value: unknown[]): void {
    const items = node.items as Node[];
    // Which old item each wanted value is, if any — so a move is a move, and
    // never an edit in place that leaves every comment above the wrong item.
    // An unchanged item is itself; a changed one is the item with its `name`,
    // or a nameless mapping at the same position. A changed label or anything
    // else is a different item: the old one goes, with its comments, and the
    // new one is added — never the old item's comments over something else.
    const olds = items.map((item) => item.toJS(this.doc));
    const used = new Set<number>();
    const claim = (test: (old: unknown, j: number) => boolean): number => {
      const k = olds.findIndex((old, j) => !used.has(j) && test(old, j));
      if (k !== -1) used.add(k);
      return k;
    };
    const match = value.map((wanted) => claim((old) => isDeepStrictEqual(old, wanted)));
    value.forEach((wanted, i) => {
      if (match[i] !== -1 || !isPlainObject(wanted)) return;
      const name = wanted["name"];
      match[i] =
        typeof name === "string"
          ? claim((old) => isPlainObject(old) && old["name"] === name)
          : claim((old, j) => j === i && isPlainObject(old) && old["name"] === undefined);
    });
    const dashColumn = this.column(this.text.lastIndexOf("-", items[0]!.range![0]));
    const kept = match.filter((k) => k !== -1);
    if (kept.some((k, i) => i > 0 && k < kept[i - 1]!)) return this.reorder(items, value, match, dashColumn);

    // Items still wanted keep their own lines, and the comments above them.
    let next = 0;
    let after = this.chunkStart(items, 0);
    value.forEach((wanted, i) => {
      const found = match[i]!;
      if (found === -1) {
        this.edits.push({ from: after, to: after, text: this.block([wanted], dashColumn) });
        return;
      }
      for (let k = next; k < found; k++) this.remove(items, k);
      this.reconcile(items[found], wanted, this.itemSite(items[found]!));
      after = this.lineEnd(items[found]!.range![1]);
      next = found + 1;
    });
    for (let k = next; k < items.length; k++) this.remove(items, k);
  }

  /** The items in their new order, each carried with the comment lines above it; the gaps between them stay. */
  private reorder(items: Node[], value: unknown[], match: number[], dashColumn: number): void {
    const starts = items.map((_, k) => this.chunkStart(items, k));
    const ends = items.map((item) => this.lineEnd(item.range![1]));
    const chunk = (text: string): string => (text.endsWith("\n") ? text : `${text}\n`);
    // A moved item that also changed is changed inside its own chunk, so its comments move with it.
    const carried = (k: number, wanted: unknown): string => {
      const inner: Edit[] = [];
      new Splicer(this.text, this.doc, inner).reconcile(items[k], wanted, this.itemSite(items[k]!));
      const shifted = inner.map((e) => ({ ...e, from: e.from - starts[k]!, to: e.to - starts[k]! }));
      return apply(this.text.slice(starts[k], ends[k]), shifted);
    };
    let text = "";
    value.forEach((wanted, i) => {
      const k = match[i]!;
      text += k === -1 ? this.block([wanted], dashColumn) : chunk(carried(k, wanted));
      if (i < value.length - 1 && i < items.length - 1) text += this.text.slice(ends[i], starts[i + 1]);
    });
    const to = ends[ends.length - 1]!;
    if (!this.text.slice(0, to).endsWith("\n")) text = text.replace(/\n$/, "");
    this.edits.push({ from: starts[0]!, to, text });
  }

  private itemSite(item: Node): Site {
    const dash = this.text.lastIndexOf("-", item.range![0]);
    return { inlineFrom: dash + 1, indent: this.column(dash) };
  }

  /** An item goes with the comment lines directly above it: they are about it. */
  private remove(items: Node[], k: number): void {
    this.edits.push({ from: this.chunkStart(items, k), to: this.lineEnd(items[k]!.range![1]), text: "" });
  }

  /** The start of item `k`'s line, or of the first comment above it, back no further than the item before. */
  private chunkStart(items: Node[], k: number): number {
    const dash = this.text.lastIndexOf("-", items[k]!.range![0]);
    const line = this.lineStart(dash);
    if (this.text.slice(line, dash).trim() !== "") {
      throw new Error("the recipe has a list item that does not start its own line, which cannot be moved in place");
    }
    return this.commentsAbove(line, k === 0 ? 0 : this.lineEnd(items[k - 1]!.range![1]));
  }

  /** The start of the first comment line directly above `line` (blank lines between allowed), back no further than `bound`. */
  private commentsAbove(line: number, bound: number): number {
    let start = line;
    let at = line;
    while (at > bound) {
      const prev = this.lineStart(at - 1);
      const content = this.text.slice(prev, at);
      if (/^\s*#/.test(content)) start = prev;
      else if (!/^\s*$/.test(content)) break;
      at = prev;
    }
    return start;
  }

  /** The whole value, re-rendered in the place the old one occupied. */
  private replace(node: unknown, value: unknown, site: Site): void {
    const old = isNode(node) ? node : null;
    const range = old?.range;
    const oldBlock = (isMap(old) || isSeq(old)) && !old.flow;
    const inline = !isObjectLike(value) || flowable(value);

    if (range && !oldBlock) {
      // A scalar or a flow collection: `key: <here> # comment` keeps its comment.
      // A block scalar's range runs to the end of its last line; the others stop at the value.
      const endsLine = this.text[range[1] - 1] === "\n";
      const frag = this.fragment(value, old, "flow");
      if (inline && /^[|>]/.test(frag)) {
        // A block scalar's body must sit deeper than its key: where the old body sat, or two past the key.
        const body = this.blockBodyColumn(range) ?? site.indent + 2;
        const nl = frag.indexOf("\n");
        const header = frag.slice(0, nl).replace(/\d/, String(body - site.indent));
        const text = `${header}\n${indentAll(frag.slice(nl + 1), body)}`.replace(/\n$/, "");
        this.edits.push({ from: range[0], to: range[1], text: endsLine ? `${text}\n` : text });
      } else if (inline) {
        const text = indentAfterFirst(frag, site.indent).replace(/\n$/, "");
        this.edits.push({ from: range[0], to: range[1], text: endsLine ? `${text}\n` : text });
      } else {
        // `key: [] # comment` keeps its comment on the key's line, not on the last line of the new block.
        const eol = this.text.indexOf("\n", range[1]);
        const rest = this.text.slice(range[1], eol === -1 ? this.text.length : eol);
        const trailing = !endsLine && /^\s*#/.test(rest) ? rest : "";
        const text = trailing + "\n" + indentAll(this.fragment(value, old, "block"), site.indent + 2).replace(/\n$/, "");
        const to = range[1] + trailing.length;
        this.edits.push({ from: this.valueFrom(site, range[0]), to, text: endsLine ? `${text}\n` : text });
      }
      return;
    }
    if (range && oldBlock) {
      if (inline) {
        const text = " " + this.fragment(value, old, "flow").replace(/\n$/, "") + "\n";
        this.edits.push({ from: this.valueFrom(site, range[0]), to: this.lineEnd(range[1]), text });
      } else {
        // Replaced from its own first line, so comments between the key and it stay.
        const col = this.column(range[0]);
        const text = indentAll(this.fragment(value, old, "block"), col);
        this.edits.push({ from: this.lineStart(range[0]), to: this.lineEnd(range[1]), text });
      }
      return;
    }
    throw new Error("the recipe has a value with no position in the file, which cannot be edited in place");
  }

  private fragment(value: unknown, old: Node | null, style: "flow" | "block"): string {
    const frag = new Document(value);
    const contents = frag.contents;
    if ((isMap(contents) || isSeq(contents)) && style === "flow") contents.flow = true;
    if (isScalar(contents) && typeof value === "string") {
      if (isScalar(old) && old.type && typeof old.value === "string" && (!value.includes("\n") || old.type.startsWith("BLOCK"))) {
        contents.type = old.type;
      } else if (value.includes("\n")) {
        contents.type = Scalar.QUOTE_DOUBLE;
      }
    }
    return frag.toString(RENDER);
  }

  /** The column of a block scalar's first non-blank body line, if it has one. */
  private blockBodyColumn(range: readonly number[]): number | undefined {
    const body = this.text.slice(this.lineEnd(range[0]!), range[1]);
    const line = body.split("\n").find((l) => l.trim() !== "");
    return line === undefined ? undefined : line.length - line.trimStart().length;
  }

  /** `key: value` pairs or `- item`s, as block lines at `column`. */
  private block(value: unknown, column: number): string {
    return indentAll(new Document(value).toString(RENDER), column);
  }

  /** From just after `key:` or `-`, so a value can move onto the lines below. */
  private valueFrom(site: Site, fallback: number): number {
    if (site.inlineFrom <= 0) return fallback;
    return site.inlineFrom;
  }

  private end(pair: Pair<Node, Node | null>): number {
    return pair.value?.range?.[1] ?? pair.key.range![1];
  }

  private lineStart(pos: number): number {
    return this.text.lastIndexOf("\n", pos - 1) + 1;
  }

  /** The start of the line after the one `pos` ends on. */
  private lineEnd(pos: number): number {
    if (pos > 0 && this.text[pos - 1] === "\n") return pos;
    const nl = this.text.indexOf("\n", pos);
    return nl === -1 ? this.text.length : nl + 1;
  }

  private column(pos: number): number {
    return pos - this.lineStart(pos);
  }
}

function apply(text: string, edits: Edit[]): string {
  const sorted = [...edits].sort((a, b) => a.from - b.from || a.to - b.to);
  let out = "";
  let cursor = 0;
  for (const edit of sorted) {
    if (edit.from < cursor) throw new Error("two changes to the recipe overlap in the file");
    out += text.slice(cursor, edit.from) + edit.text;
    cursor = edit.to;
  }
  return out + text.slice(cursor);
}

function findPair(map: YAMLMap, key: string): Pair | undefined {
  return map.items.find((p) => isScalar(p.key) && String(p.key.value) === key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isObjectLike(value: unknown): boolean {
  return typeof value === "object" && value !== null;
}

/** Short enough to sit on the line it replaces: empty, or a list of scalars. */
function flowable(value: unknown): boolean {
  if (Array.isArray(value)) return value.every((v) => !isObjectLike(v) && !(typeof v === "string" && v.includes("\n")));
  return isPlainObject(value) && Object.keys(value).length === 0;
}

function indentAll(text: string, column: number): string {
  const pad = " ".repeat(column);
  return text.replace(/^(?=.)/gm, pad);
}

function indentAfterFirst(text: string, column: number): string {
  const pad = " ".repeat(column);
  return text.replace(/\n(?=.)/g, `\n${pad}`);
}

function wrap(sentence: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of sentence.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line && line.length + 1 + word.length > width) {
        lines.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    lines.push(line);
  }
  return lines;
}
