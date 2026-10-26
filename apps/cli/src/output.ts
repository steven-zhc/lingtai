/**
 * What a command prints (0121, #616): sections, aligned key/values, tables,
 * the ADR's symbols, and one `--json` document.
 *
 * Rendering returns strings and printing is separate, so the module is tested
 * with no process. It chooses no colour of its own — `paint` and `coloured()`
 * from `@lingtai/env/colour` do, and plain mode is decided there (0121 §3).
 */
import { paint } from '@lingtai/env/colour'

const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

/** The text with any colour removed. */
export function stripColour(text: string): string {
  return text.replace(SGR, '')
}

const graphemes = new Intl.Segmenter()

/** East Asian Wide and Fullwidth blocks, and the emoji planes. */
function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0xa4cf) ||
    (code >= 0xa960 && code <= 0xa97f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f1e6 && code <= 0x1f1ff) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f680 && code <= 0x1f6ff) ||
    (code >= 0x1f900 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
}

const MARK = /^[\p{Mn}\p{Me}\p{Cf}\p{Cc}]+$/u

/** Visible width in terminal columns: wide characters count two, combining marks and controls none. */
export function width(text: string): number {
  let columns = 0
  for (const { segment } of graphemes.segment(stripColour(text))) {
    if (MARK.test(segment)) continue
    const high = segment.charCodeAt(0)
    const first =
      high >= 0xd800 && high <= 0xdbff ? (high - 0xd800) * 0x400 + (segment.charCodeAt(1) - 0xdc00) + 0x10000 : high
    columns += isWide(first) || segment.includes('\u{FE0F}') ? 2 : 1
  }
  return columns
}

function pad(text: string, to: number): string {
  return text + ' '.repeat(Math.max(0, to - width(text)))
}

/** The ADR's symbols (0121 §2). ● is amber, and amber is for a person being waited on. */
export const symbol = {
  pass: (): string => paint.pass('✓'),
  fail: (): string => paint.fail('✗'),
  signal: (): string => paint.signal('●'),
}

export function heading(title: string): string {
  return paint.accent(title)
}

/** A heading and its lines, indented under it. */
export function section(title: string, lines: readonly string[]): string {
  return [heading(title), ...lines.map((line) => (line === '' ? '' : `  ${line}`))].join('\n')
}

/** `key  value` with the values in one column. */
export function keyValues(pairs: readonly (readonly [string, string])[]): string[] {
  const keyWidth = Math.max(0, ...pairs.map(([key]) => width(key)))
  return pairs.map(([key, value]) => `${paint.muted(pad(key, keyWidth))}  ${value}`)
}

/**
 * Columns padded to their widest cell. `columns` is the terminal's width, and
 * `undefined` is a redirected stream, which is never truncated. A table wider
 * than the terminal becomes one key/value block per row (0121 §4).
 */
export function table(
  header: readonly string[],
  rows: readonly (readonly string[])[],
  options: { columns?: number | undefined } = {},
): string[] {
  const widths = header.map((h, i) => Math.max(width(h), ...rows.map((row) => width(row[i] ?? ''))))
  const total = widths.reduce((a, b) => a + b, 0) + 2 * Math.max(0, widths.length - 1)
  if (options.columns !== undefined && total > options.columns) {
    return rows.flatMap((row, r) => [
      ...(r > 0 ? [''] : []),
      ...keyValues(header.map((h, i) => [h, row[i] ?? ''] as const)),
    ])
  }
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, i) => (i === cells.length - 1 ? cell : pad(cell, widths[i] ?? 0)))
      .join('  ')
      .trimEnd()
  return [line(header.map((h) => paint.muted(h))), ...rows.map(line)]
}

/** The schema `version` every `--json` document carries; `doc/cli.json` reads it from here (#545). */
export const JSON_VERSION = 1

/** The one document `--json` prints: 0121 §5's schema `version`, the command, then the body. */
export function jsonDocument(command: string, body: Record<string, unknown>): string {
  return JSON.stringify({ version: JSON_VERSION, command, ...body })
}

export function jsonErrorDocument(command: string, code: string, message: string): string {
  return jsonDocument(command, { error: { code, message } })
}

type Out = { write(text: string): unknown }

export function printJson(command: string, body: Record<string, unknown>, out: Out = process.stdout): void {
  out.write(`${jsonDocument(command, body)}\n`)
}

/** Prints the error document and returns the code to exit with. */
export function printJsonError(command: string, code: string, message: string, out: Out = process.stdout): number {
  out.write(`${jsonErrorDocument(command, code, message)}\n`)
  return 1
}

/** `--no-color` is `NO_COLOR` for this process (0121 §3); `coloured()` does the rest. */
export function applyNoColor(): void {
  process.env['NO_COLOR'] = '1'
}
