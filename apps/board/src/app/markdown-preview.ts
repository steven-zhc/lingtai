/**
 * The live preview of `MarkdownField` (#1372), as CodeMirror state alone: no React, no DOM.
 *
 * The preview is decoration only — the document is exactly the characters typed. Three CodeMirror defaults
 * would rewrite them and are switched off here: `markdown()`'s own keymap (continues and renumbers lists),
 * `defaultKeymap`'s Enter (`insertNewlineAndIndent` strips a trailing hard break), and the line separator
 * (`\r\n` would be split and joined back with `\n`).
 */
import {
  defaultKeymap,
  deleteCharBackward,
  deleteCharBackwardStrict,
  history,
  historyKeymap,
  indentLess,
  indentMore,
  indentSelection,
  insertBlankLine,
  insertNewline,
  insertNewlineAndIndent,
  toggleComment,
  toggleLineComment,
} from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { syntaxTree } from '@codemirror/language'
import {
  Annotation,
  type ChangeSpec,
  EditorState,
  type Extension,
  Prec,
  type Range,
  type Text,
} from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view'

/** Marks a transaction that came from outside (a new `value`), so it is not handed back to `onChange`. */
export const fromOutside = Annotation.define<boolean>()

/** The minimal change that makes `doc` read `value`, or `null` when they already match. */
export function changeFor(doc: string, value: string): { from: number; to: number; insert: string } | null {
  if (doc === value) return null
  let from = 0
  while (from < doc.length && from < value.length && doc[from] === value[from]) from++
  let end = doc.length
  let tail = value.length
  while (end > from && tail > from && doc[end - 1] === value[tail - 1]) {
    end--
    tail--
  }
  return { from, to: end, insert: value.slice(from, tail) }
}

/** The Enter binding: a newline and nothing else, so `- a␠␠` and `1. a` come back as typed. Shift-Enter is the same. */
export const enterBinding = { key: 'Enter', shift: insertNewline, run: insertNewline }

/** Default commands that rewrite whitespace or add text of their own; none of them is bound here. */
const REWRITING = new Set<unknown>([
  insertNewlineAndIndent,
  insertBlankLine,
  indentSelection,
  indentMore,
  indentLess,
  toggleComment,
  toggleLineComment,
])

/** `defaultKeymap` without the commands that would change the text on their own; Backspace deletes one character. */
export const textKeymap = defaultKeymap
  .filter((b) => ![b.run, b.shift].some((c) => c && REWRITING.has(c)))
  .map((b) => (b.run === deleteCharBackward ? { ...b, run: deleteCharBackwardStrict } : b))

const hide = Decoration.replace({})
const dim = Decoration.mark({ class: 'md-dim' })

class Bullet extends WidgetType {
  override eq(other: Bullet) {
    return other instanceof Bullet
  }
  override toDOM() {
    const span = document.createElement('span')
    span.className = 'md-bullet'
    span.textContent = '•'
    return span
  }
}
const bullet = Decoration.replace({ widget: new Bullet() })

const line = (cls: string) => Decoration.line({ class: cls })
const mark = (cls: string) => Decoration.mark({ class: cls })

/** The 1-based numbers of the lines a selection touches, only while the field has focus. */
export function activeLines(state: EditorState, focused: boolean): Set<number> {
  const out = new Set<number>()
  if (!focused) return out
  for (const r of state.selection.ranges) {
    const first = state.doc.lineAt(r.from).number
    const last = state.doc.lineAt(r.to).number
    for (let n = first; n <= last; n++) out.add(n)
  }
  return out
}

/** Markers that are hidden off the cursor line and dimmed on it. */
const MARKERS = new Set(['HeaderMark', 'EmphasisMark', 'CodeMark', 'LinkMark', 'URL', 'QuoteMark'])

/**
 * Every decoration for the document as it stands. A part the parser has not reached is drawn plain.
 * `readOnly` never shows a line's Markdown; otherwise the lines touched by a selection do, while focused.
 */
export function buildDecorations(state: EditorState, focused: boolean, readOnly: boolean): DecorationSet {
  const doc: Text = state.doc
  const active = readOnly ? new Set<number>() : activeLines(state, focused)
  const out: Range<Decoration>[] = []
  const lineOf = (pos: number) => doc.lineAt(pos)
  const isActive = (pos: number) => active.has(lineOf(pos).number)
  for (const n of active) out.push(line('md-src').range(doc.line(n).from))

  const fenceLines = new Set<number>()
  syntaxTree(state).iterate({
    enter: (node) => {
      const { name, from, to } = node
      const heading = /^ATXHeading([1-6])$/.exec(name)
      if (heading) {
        out.push(line(`md-h md-h${heading[1]}`).range(lineOf(from).from))
      } else if (name === 'SetextHeading1' || name === 'SetextHeading2') {
        out.push(line(`md-h md-h${name.slice(-1)}`).range(lineOf(from).from))
      } else if (name === 'StrongEmphasis') {
        if (to > from) out.push(mark('md-strong').range(from, to))
      } else if (name === 'Emphasis') {
        if (to > from) out.push(mark('md-em').range(from, to))
      } else if (name === 'InlineCode') {
        if (to > from) out.push(mark('md-code').range(from, to))
      } else if (name === 'Link') {
        if (to > from) out.push(mark('md-link').range(from, to))
      } else if (name === 'Blockquote') {
        for (let n = lineOf(from).number; n <= lineOf(to).number; n++)
          out.push(line('md-quote').range(doc.line(n).from))
      } else if (name === 'FencedCode') {
        const first = lineOf(from).number
        const last = lineOf(to).number
        for (let n = first; n <= last; n++) out.push(line('md-fenced').range(doc.line(n).from))
        fenceLines.add(first)
        // A closing fence is a line of marks alone; an unclosed block has none.
        if (last > first && /^\s*(`{3,}|~{3,})\s*$/.test(doc.line(last).text)) fenceLines.add(last)
      } else if (name === 'ListMark') {
        const text = doc.sliceString(from, to)
        if (/^[-*+]$/.test(text) && !isActive(from)) out.push(bullet.range(from, to))
        else if (to > from) out.push(mark('md-listmark').range(from, to))
      } else if (MARKERS.has(name) && to > from) {
        if (name === 'URL' && node.node.parent?.name === 'Autolink') {
          // `<https://x>` shows its address; only the angle brackets are marks.
          out.push(mark('md-link').range(from, to))
        } else if (isActive(from)) out.push(dim.range(from, to))
        else if (name === 'QuoteMark') {
          const spaced = doc.sliceString(to, to + 1) === ' ' ? to + 1 : to
          out.push(hide.range(from, spaced))
        } else if (name === 'CodeMark' && fenceLines.has(lineOf(from).number)) {
          // The fence line is collapsed as a whole below.
        } else out.push(hide.range(from, to))
      }
    },
  })
  for (const n of fenceLines) {
    const l = doc.line(n)
    if (active.has(n)) {
      if (l.to > l.from) out.push(dim.range(l.from, l.to))
    } else {
      out.push(line('md-fence-hidden').range(l.from))
      if (l.to > l.from) out.push(hide.range(l.from, l.to))
    }
  }
  return Decoration.set(out, true)
}

/** The decorations, rebuilt when the text, the selection or the focus moves. */
function previewPlugin(readOnly: boolean) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view.state, view.hasFocus, readOnly)
      }
      update(u: ViewUpdate) {
        if (
          u.docChanged ||
          u.selectionSet ||
          u.focusChanged ||
          u.viewportChanged ||
          syntaxTree(u.state) !== syntaxTree(u.startState)
        )
          this.decorations = buildDecorations(u.state, u.view.hasFocus, readOnly)
      }
    },
    { decorations: (v) => v.decorations },
  )
}

/** What the preview looks like, in the board's variables. */
const theme = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: 'var(--ink)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: '1.5' },
  '.cm-content': { caretColor: 'var(--ink)', padding: '0' },
  '.cm-cursor': { borderLeftColor: 'var(--ink)' },
  '.cm-line': { padding: '0' },
  '.md-src': { fontFamily: 'var(--mono)' },
  '.md-dim': { color: 'var(--muted)' },
  '.md-h': { fontWeight: '600' },
  '.md-h1': { fontSize: '1.5em' },
  '.md-h2': { fontSize: '1.3em' },
  '.md-h3': { fontSize: '1.15em' },
  '.md-strong': { fontWeight: '700' },
  '.md-em': { fontStyle: 'italic' },
  '.md-code': { fontFamily: 'var(--mono)', background: 'var(--surface-2)', borderRadius: 'var(--radius)' },
  '.md-link': { color: 'var(--accent-ink)', textDecoration: 'underline' },
  '.md-quote': { borderLeft: '3px solid var(--rule-2)', paddingLeft: '0.75em', color: 'var(--muted)' },
  '.md-fenced': { fontFamily: 'var(--mono)', background: 'var(--surface-2)', paddingLeft: '0.5em' },
  '.md-fence-hidden': { fontSize: '0', lineHeight: '0', height: '0', overflow: 'hidden' },
  '.md-listmark': { color: 'var(--muted)' },
  '.md-bullet': { color: 'var(--muted)' },
})

export type PreviewOptions = { readOnly: boolean; placeholder?: Extension }

/** What does not depend on the props: the parser, wrapping and the look. */
export function baseExtensions(): Extension[] {
  return [EditorState.lineSeparator.of('\n'), markdown({ addKeymap: false }), EditorView.lineWrapping, theme]
}

/**
 * What depends on `readOnly`: the decorations (a read-only field never shows Markdown), editability and the keys.
 * Kept apart so the editor can swap it when the prop changes. There is no `indentWithTab` (Tab moves focus, as in a
 * textarea), no `indentOnInput` and no `closeBrackets`, and no default key that re-indents or rewrites whitespace.
 */
export function modeExtensions(readOnly: boolean): Extension[] {
  return [
    previewPlugin(readOnly),
    ...(readOnly
      ? [EditorView.editable.of(false), EditorState.readOnly.of(true)]
      : [history(), Prec.high(keymap.of([enterBinding])), keymap.of([...textKeymap, ...historyKeymap])]),
  ]
}

/** The extensions the field runs on, for a state built at once. See the head of this file for what is switched off. */
export function previewExtensions({ readOnly, placeholder }: PreviewOptions): Extension[] {
  return [...baseExtensions(), ...modeExtensions(readOnly), ...(placeholder ? [placeholder] : [])]
}

/** A change from outside, ready to dispatch: only the middle that differs, annotated so it is not echoed. */
export function outsideTransaction(
  state: EditorState,
  value: string,
): { changes: ChangeSpec; annotations: ReturnType<typeof fromOutside.of> } | null {
  const change = changeFor(state.doc.toString(), value)
  return change === null ? null : { changes: change, annotations: fromOutside.of(true) }
}
