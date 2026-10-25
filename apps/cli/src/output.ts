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

/** Visible width: what a column measures, with any colour stripped. */
export function width(text: string): number {
  return [...text.replace(SGR, '')].length
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

/** The one document `--json` prints: 0121 §5's schema `version`, the command, then the body. */
export function jsonDocument(command: string, body: Record<string, unknown>): string {
  return JSON.stringify({ version: 1, command, ...body })
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
