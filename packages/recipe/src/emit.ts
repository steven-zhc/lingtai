/**
 * Writing a recipe down: a new one with its reasons in it, and an edit to one
 * that keeps the reasons somebody else wrote (#162).
 *
 * **`parse` is fine for reading. It is `stringify` that must never touch a file
 * a person has edited.** Parsing this repository's own recipe to an object and
 * stringifying it back destroys 74 of its 503 lines, and those comments are the
 * reason anybody dares change the file.
 *
 * An edit is made on the `parseDocument` tree, where every comment is attached
 * to the node it sits beside. Two things are not left to that tree:
 *
 * - **Which node a value is.** A change names a path, and the node at that path
 *   is edited where it stands, keeping its comments. A whole list given as a
 *   value keeps an item's node only when the same value is in the new list —
 *   never by position and never by a field that looks like a name, because a
 *   guess that pairs `epic2` with `agent:wip` hands one label's explanation to
 *   another and reads as success. An item with a comment that the new list does
 *   not keep is refused by name, with the path that would say it outright.
 *
 * - **The bytes.** `Document.toString()` is a rendering, not the file: on this
 *   repository's recipe it drops a blank line and re-indents the sixteen-line
 *   comment above `merge:` with nothing changed. So the tree is rendered twice,
 *   before and after, and only the lines that differ between those two are
 *   carried onto the person's own text. Anything that cannot be carried exactly
 *   throws, and the result must re-render to the edited tree — meaning and
 *   every comment — or it is not returned.
 */
import {
  Document,
  isCollection,
  isMap,
  isNode,
  isPair,
  isScalar,
  isSeq,
  parseDocument,
  visit,
  type Node,
  type Pair,
  type YAMLMap,
} from "yaml";
import { isDeepStrictEqual } from "node:util";
import { Recipe } from "./recipe.ts";

/**
 * The sentences the wizard showed, by the dotted path of the block each one is
 * about — `{ "source.kinds": "order is priority" }`. The same words the person
 * just read, so a generated file does not carry a second explanation of a field.
 */
export type Said = Readonly<Record<string, string>>;

/**
 * One value set at a path. `undefined` removes what is there, with its comments.
 *
 * The path is what says which node is meant: `["source", "exclude", 6]` set to
 * `"epic2"` renames that label where it stands, and its comment stays. A whole
 * list or mapping as the value keeps each item or key whose value is unchanged,
 * and refuses to drop one that carries a comment.
 */
export interface RecipeChange {
  path: readonly (string | number)[];
  value: unknown;
}

/** An edit that would silently lose a comment, refused rather than written. */
export class CommentWouldBeLostError extends Error {
  // Fields, not parameter properties: the source runs unbuilt (0010), and type stripping refuses those.
  readonly path: readonly (string | number)[];
  readonly comment: string;

  constructor(path: readonly (string | number)[], comment: string, remedy?: string) {
    const at = path.join(".");
    super(
      `${at} carries a comment ("${comment.split("\n")[0]!.trim()}") and this change would remove it without naming it: ` +
        (remedy ?? `set ${at} itself to change it where it stands, or remove ${at} to drop it and its comment`),
    );
    this.name = "CommentWouldBeLostError";
    this.path = path;
    this.comment = comment;
  }
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
 * `Recipe.parse`, if a change would drop a comment it did not name
 * ({@link CommentWouldBeLostError}), or if the changed lines cannot be carried
 * onto the file exactly.
 */
export function editRecipe(existing: string, changes: readonly RecipeChange[]): string {
  const doc = read(existing);
  if (doc.errors.length > 0) throw new Error(`the recipe does not parse: ${doc.errors[0]!.message}`);
  if (!isMap(doc.contents)) throw new Error("the recipe is not a mapping");

  const before = doc.toString(RENDER);
  const firsts = firstLines(doc);
  for (const { path, value } of changes) {
    if (value === undefined) doc.deleteIn(path);
    else if (doc.hasIn(path)) replace(doc, path, value);
    else doc.setIn(path, value);
  }
  // A blank line above an item is space between items, and a new first item has nothing above it.
  for (const [collection, first] of firstLines(doc)) {
    if (first !== firsts.get(collection) && first.spaceBefore) first.spaceBefore = false;
  }
  Recipe.parse(doc.toJS());
  const after = doc.toString(RENDER);
  if (after === before) return existing;

  const out = carry(existing, before, after);
  // The check that makes the splice safe to trust: the file written must be the
  // edited tree, comments and all, and not merely parse to the same recipe.
  if (read(out).toString(RENDER) !== after) {
    throw new Error(
      `the change to ${changes.map((c) => c.path.join(".")).join(", ")} could not be carried onto the file exactly, ` +
        "and writing the document out whole would reformat what a person wrote",
    );
  }
  return out;
}

/**
 * The file's tree, with each comment on the line it sits directly above.
 *
 * `yaml` gives two kinds of comment to the collection beside them rather than
 * to the line a person reads them as about:
 *
 * - one between `key:` and the first line under it, which it reads onto the
 *   collection — so the paragraph above `- name: build` would stay at the top
 *   of `proposed` when `build` moves, above a gate it says nothing about;
 * - one after a collection at the indent of the key that follows, which it
 *   reads onto the collection before — so the sixteen lines above `merge:`
 *   belong to `proposed`, and would stay behind when `merge` is removed.
 *
 * Both are given to the line below them, which is where an edit moves them.
 */
function read(text: string): Document {
  const doc = parseDocument(text);
  visit(doc, {
    Map(_, map) {
      map.items.forEach((pair, i) => {
        const value = pair.value;
        if (!isCollection(value) || value.flow) return;
        if (value.commentBefore && value.items.length > 0) {
          const first = value.items[0];
          const target = isPair(first) ? first.key : first;
          if (isNode(target)) {
            target.commentBefore = join(value.commentBefore, target.commentBefore);
            value.commentBefore = undefined;
          }
        }
        const next = map.items[i + 1]?.key;
        if (value.comment && isNode(next) && next.range && value.range) giveTrailing(text, value, next);
      });
    },
  });
  return doc;
}

/** Move the comment lines after `value` that sit at `next`'s indent onto `next`. */
function giveTrailing(text: string, value: Node, next: Node): void {
  const lines = text.slice(value.range![1], value.range![2]).split("\n");
  lines.pop(); // the indent before `next` itself
  const entries = value.comment!.split("\n");
  if (lines.length === entries.length + 1 && lines[0]!.trim() === "") lines.shift();
  // Only where every entry can be matched to its line; otherwise leave it as read.
  if (lines.length !== entries.length) return;
  const column = next.range![0] - (text.lastIndexOf("\n", next.range![0] - 1) + 1);
  let start = lines.length;
  while (start > 0) {
    const line = lines[start - 1]!;
    const indent = line.length - line.trimStart().length;
    if (line.trim() !== "" && !(line.trimStart().startsWith("#") && indent === column)) break;
    start--;
  }
  let first = start;
  while (first < lines.length && lines[first]!.trim() === "") first++;
  if (first === lines.length) return;
  next.commentBefore = join(entries.slice(first).join("\n"), next.commentBefore);
  if (first > start) next.spaceBefore = true;
  let keep = start;
  while (keep > 0 && lines[keep - 1]!.trim() === "") keep--;
  value.comment = keep > 0 ? entries.slice(0, keep).join("\n") : undefined;
}

function join(above: string, below: string | null | undefined): string {
  return below ? `${above}\n${below}` : above;
}

/** The node each block collection's first line is written from: an item, or a key. */
function firstLines(doc: Document): Map<unknown, Node> {
  const firsts = new Map<unknown, Node>();
  visit(doc, (_, node) => {
    if (!isCollection(node) || node.flow || node.items.length === 0 || node === doc.contents) return;
    const first = node.items[0];
    const line = isPair(first) ? first.key : first;
    if (isNode(line)) firsts.set(node, line);
  });
  return firsts;
}

/** Set the node at an existing `path` to `value`, keeping every node that is still the same value. */
function replace(doc: Document, path: readonly (string | number)[], value: unknown): void {
  const parentPath = path.slice(0, -1);
  const key = path[path.length - 1]!;
  const parent = parentPath.length === 0 ? doc.contents : doc.getIn(parentPath, true);
  const old = isCollection(parent) ? (parent.get(key, true) as unknown) : undefined;
  // A list item is known by its value, not its position: a different mapping or
  // list at its index is a different item, and is held to the whole-list rule.
  if (isSeq(parent) && isCollection(old) && isObjectLike(value) && !isDeepStrictEqual(toJS(old), value)) {
    refuseIfCommented(old, path, true, "set the fields inside it by their own paths, or remove it with its comment and add the new item");
    doc.setIn(path, doc.createNode(value));
    return;
  }
  const next = reconcile(doc, path, old, value);
  if (next === old) return;
  if (isNode(old) && isNode(next)) {
    // The node at the named path is the one the person named: what they wrote about it stays.
    next.commentBefore = old.commentBefore;
    next.comment = old.comment;
    next.spaceBefore = old.spaceBefore;
  }
  doc.setIn(path, next);
}

/** The node `value` should be, reusing `old` where it can be kept honestly. */
function reconcile(doc: Document, path: readonly (string | number)[], old: unknown, value: unknown): unknown {
  if (isScalar(old) && !isObjectLike(value)) {
    old.value = value;
    return old;
  }
  if (isMap(old) && isPlainObject(value)) {
    for (const pair of [...old.items]) {
      const k = keyOf(pair);
      if (!Object.hasOwn(value, k) || value[k] === undefined) {
        refuseIfCommented(pair, [...path, k]);
        old.delete(k);
      }
    }
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      const pair = findPair(old, k);
      if (!pair) {
        old.set(doc.createNode(k), doc.createNode(v));
        continue;
      }
      const next = reconcile(doc, [...path, k], pair.value, v);
      if (next !== pair.value) {
        moveComments(pair.value, next);
        pair.value = next;
      }
    }
    return old;
  }
  if (isSeq(old) && Array.isArray(value)) {
    const items = old.items as unknown[];
    const kept = new Set<number>();
    const next = value.map((v) => {
      const i = items.findIndex((item, j) => !kept.has(j) && isDeepStrictEqual(toJS(item), v));
      if (i === -1) return doc.createNode(v);
      kept.add(i);
      return items[i];
    });
    items.forEach((item, i) => {
      if (!kept.has(i)) refuseIfCommented(item, [...path, i]);
    });
    old.items = next;
    // A flow list stays on its line only while it is a line's worth of scalars,
    // and the comment that followed it on that line stays beside its key.
    if (old.flow && value.some(isObjectLike)) {
      old.flow = false;
      if (old.comment && !old.commentBefore) [old.commentBefore, old.comment] = [old.comment, undefined];
    }
    return old;
  }
  if (isNode(old)) refuseIfCommented(old, path, false);
  return doc.createNode(value);
}

/** Refuse to drop `node` if it, or anything inside it, carries a comment. */
function refuseIfCommented(node: unknown, path: readonly (string | number)[], self = true, remedy?: string): void {
  const found = (n: unknown): string | undefined => {
    if (isPair(n)) return (n.key as Node | null)?.commentBefore ?? (n.key as Node | null)?.comment ?? found(n.value);
    if (!isNode(n)) return undefined;
    let comment = self ? (n.commentBefore ?? n.comment) : undefined;
    if (!comment && isCollection(n)) {
      visit(n, (_, inner) => {
        if (isNode(inner) && inner !== n && (inner.commentBefore || inner.comment)) {
          comment = (inner.commentBefore || inner.comment)!;
          return visit.BREAK;
        }
      });
    }
    return comment || undefined;
  };
  const comment = found(node);
  if (comment) throw new CommentWouldBeLostError(path, comment, remedy);
}

function moveComments(from: unknown, to: unknown): void {
  if (!isNode(from) || !isNode(to)) return;
  to.commentBefore = from.commentBefore;
  to.comment = from.comment;
  to.spaceBefore = from.spaceBefore;
}

/**
 * `existing` with the line changes between two renderings of its tree carried
 * onto it. `before` is `existing` as the tree renders it, so the two are the
 * same file with the renderer's differences — which lines those are is found by
 * aligning them, and a changed line has to land on a line the alignment is sure of.
 */
function carry(existing: string, before: string, after: string): string {
  // A rendering always ends in a newline and never has a "\r": the file is
  // compared without its own, and a line carried onto it is given them.
  const cr = existing.includes("\r\n") ? "\r" : "";
  const open = !existing.endsWith("\n");
  const file = (open ? `${existing}${cr}\n` : existing).split("\n");
  const E = file.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  const B = before.split("\n");
  const A = after.split("\n");
  const toE = new Map(align(B, E).map(([b, e]) => [b, e]));

  const hunks: { from: number; to: number; lines: string[] }[] = [];
  const pairs = align(B, A);
  let b = 0;
  let a = 0;
  for (const [nb, na] of [...pairs, [B.length, A.length] as const]) {
    if (nb > b || na > a) hunks.push(onto(toE, B.length, E, b, nb, A.slice(a, na).map((line) => line + cr)));
    b = nb + 1;
    a = na + 1;
  }

  let out: string[] = [];
  let cursor = 0;
  for (const hunk of hunks) {
    if (hunk.from < cursor) throw new Error("two changes to the recipe overlap in the file");
    out = out.concat(file.slice(cursor, hunk.from), hunk.lines);
    cursor = hunk.to;
  }
  const text = out.concat(file.slice(cursor)).join("\n");
  return open ? text.slice(0, -`${cr}\n`.length) : text;
}

/** Where rendered lines `B[from, to)` stand in the file, as a range of its lines. */
function onto(toE: Map<number, number>, rendered: number, existing: readonly string[], from: number, to: number, lines: string[]) {
  const length = existing.length;
  const unsure = () => new Error("a changed line sits where the file and its rendering disagree");
  if (to > from) {
    const start = toE.get(from);
    if (start === undefined) throw unsure();
    for (let i = from; i < to; i++) if (toE.get(i) !== start + (i - from)) throw unsure();
    return { from: start, to: start + (to - from), lines };
  }
  // A pure insertion goes between two lines the file and its rendering agree
  // on, and only where nothing of the person's sits between them.
  const prev = from === 0 ? -1 : toE.get(from - 1);
  const next = from === rendered ? length : toE.get(from);
  if (prev === undefined || next === undefined || next <= prev) throw unsure();
  // Between them only blank lines the renderer does not keep: the new lines go
  // above those, so the space stays with what follows it.
  for (let i = prev + 1; i < next; i++) if (existing[i]!.trim() !== "") throw unsure();
  return { from: prev + 1, to: prev + 1, lines };
}

/** A longest common subsequence of lines, as index pairs in order. */
function align(x: readonly string[], y: readonly string[]): [number, number][] {
  let head = 0;
  while (head < x.length && head < y.length && x[head] === y[head]) head++;
  let tail = 0;
  while (tail < x.length - head && tail < y.length - head && x[x.length - 1 - tail] === y[y.length - 1 - tail]) tail++;
  const xs = x.slice(head, x.length - tail);
  const ys = y.slice(head, y.length - tail);
  const w = ys.length + 1;
  const table = new Uint32Array((xs.length + 1) * w);
  for (let i = xs.length - 1; i >= 0; i--) {
    for (let j = ys.length - 1; j >= 0; j--) {
      table[i * w + j] =
        xs[i] === ys[j] ? table[(i + 1) * w + j + 1]! + 1 : Math.max(table[(i + 1) * w + j]!, table[i * w + j + 1]!);
    }
  }
  const pairs: [number, number][] = [];
  for (let i = 0; i < head; i++) pairs.push([i, i]);
  let i = 0;
  let j = 0;
  while (i < xs.length && j < ys.length) {
    if (xs[i] === ys[j]) pairs.push([head + i++, head + j++]);
    else if (table[(i + 1) * w + j]! >= table[i * w + j + 1]!) i++;
    else j++;
  }
  for (let k = tail; k > 0; k--) pairs.push([x.length - k, y.length - k]);
  return pairs;
}

function toJS(node: unknown): unknown {
  return isNode(node) ? node.toJSON() : node;
}

function keyOf(pair: Pair): string {
  return String(isScalar(pair.key) ? pair.key.value : pair.key);
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
