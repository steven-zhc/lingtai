/**
 * 0129 §7: every append to a Ticket stream belongs in the owner, `packages/conductor/src/ticket/`. This counts the
 * ones that are not there, per file, against `aggregate-owners.baseline.json`, red in both directions as the Effect
 * ratchet is (#790): a file over its number is a new outside append, a file under it means the baseline is
 * lowered in the same commit.
 *
 * A **Ticket append** is a call expression in a `.ts`/`.tsx` file under a package's or an app's `src` (not the
 * owner, `packages/domain/src` or `packages/event-store/src`) whose callee name is in `APPEND_CALLEES` and which
 * either (1) passes as an argument a `ticketStream(…)` call or an identifier or property access named `ticketId` or
 * `taskId`, or (2) has, in an object-literal argument or an array-literal argument's elements, a `type:` string
 * literal naming an event whose `STREAMS` row is exactly `['ticket-']`. A call matching both counts once.
 * The rule is the contract: a shape it does not name is not counted.
 *
 * Counted with the TypeScript parser, one `createSourceFile` per file and no `Program` (#785). The test never
 * writes the baseline: a unit test that edits the checkout would undo the ratchet. A red prints the JSON to paste.
 */
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { APPEND_CALLEES, STREAMS } from '../scripts/events.ts'
import { parse } from '../test/ts-modules.ts'
import baseline from './aggregate-owners.baseline.json'

const root = fileURLToPath(new URL('../../../', import.meta.url))

/** The stream prefixes the baseline keys. Pinned here: a baseline that could drop a key would be a way out. */
const PREFIXES = ['ticket-'] as const

/** Where Ticket appends belong, and the two places that define events rather than append them. */
const NOT_COUNTED_UNDER = ['packages/conductor/src/ticket/', 'packages/domain/src/', 'packages/event-store/src/']

const TICKET_EVENTS: ReadonlySet<string> = new Set(
  Object.entries(STREAMS as Record<string, readonly string[]>)
    .filter(([, rows]) => rows.length === 1 && rows[0] === 'ticket-')
    .map(([name]) => name),
)

/** The name an expression ends in: `ticketId`, `input.taskId` → `taskId`, `store.append` → `append`. */
function lastName(e: ts.Expression): string | undefined {
  while (ts.isNonNullExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression
  if (ts.isIdentifier(e)) return e.text
  if (ts.isPropertyAccessExpression(e)) return e.name.text
  return undefined
}

function namesTicketStream(arg: ts.Expression): boolean {
  while (ts.isNonNullExpression(arg) || ts.isParenthesizedExpression(arg)) arg = arg.expression
  if (ts.isCallExpression(arg) && lastName(arg.expression) === 'ticketStream') return true
  const n = lastName(arg)
  return n === 'ticketId' || n === 'taskId'
}

function hasTicketType(obj: ts.ObjectLiteralExpression): boolean {
  return obj.properties.some(
    (p) =>
      ts.isPropertyAssignment(p) &&
      (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
      p.name.text === 'type' &&
      ts.isStringLiteralLike(p.initializer) &&
      TICKET_EVENTS.has(p.initializer.text),
  )
}

function carriesTicketEvent(arg: ts.Expression): boolean {
  if (ts.isObjectLiteralExpression(arg)) return hasTicketType(arg)
  if (ts.isArrayLiteralExpression(arg)) {
    return arg.elements.some((el) => ts.isObjectLiteralExpression(el) && hasTicketType(el))
  }
  return false
}

/** Is a file one the rule reads at all? */
export function isCounted(path: string): boolean {
  return /^(packages|apps)\/[^/]+\/src\//.test(path) && !NOT_COUNTED_UNDER.some((p) => path.startsWith(p))
}

/** The line of every Ticket append in one file's text. A file that does not parse throws, naming itself. */
export function ticketAppends(name: string, text: string): { line: number }[] {
  const sf = parse(name, text)
  const out: { line: number }[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = lastName(node.expression)
      if (
        callee !== undefined &&
        APPEND_CALLEES.has(callee) &&
        node.arguments.some((a) => namesTicketStream(a) || carriesTicketEvent(a))
      ) {
        out.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/** Measured against listed, per file, in both directions. Empty when they agree. */
export function compare(
  measured: Readonly<Record<string, number>>,
  listed: Readonly<Record<string, number>>,
): string[] {
  const problems: string[] = []
  for (const file of [...new Set([...Object.keys(measured), ...Object.keys(listed)])].sort()) {
    const n = measured[file] ?? 0
    const base = listed[file] ?? 0
    if (n > base) {
      problems.push(
        `${file} has ${n} Ticket append${n === 1 ? '' : 's'}, baseline ${base}: a new append to a ticket stream belongs in packages/conductor/src/ticket/ (0129 §7). Never raise the baseline.`,
      )
    } else if (n < base) {
      problems.push(
        `${file} has ${n} Ticket append${n === 1 ? '' : 's'}, baseline ${base}: lower it to ${n} in aggregate-owners.baseline.json in this change${n === 0 ? ' (remove the entry)' : ''}.`,
      )
    }
  }
  return problems
}

async function walk(dir: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) found.push(...(await walk(path)))
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) found.push(path)
  }
  return found.sort()
}

describe('the Ticket append count (0129 §7, #1202)', () => {
  const one = (text: string, name = 'packages/x/src/a.ts'): number => ticketAppends(name, text).length

  describe('the rule', () => {
    it('counts an argument named ticketId or taskId, or a ticketStream(…) call', () => {
      expect(one(`store.append(ticketId, [e])`)).toBe(1)
      expect(one(`deps.store.append(input.taskId, e, 3)`)).toBe(1)
      expect(one(`appendNow(ticketStream(project, 7), [e])`)).toBe(1)
      expect(one(`append(s.ticketStream(p, 7), e)`)).toBe(1)
    })
    it('counts a type: literal naming a ticket-only event, on any stream argument', () => {
      expect(one(`store.append(stream, { type: 'TicketClaimed', data: {} })`)).toBe(1)
      expect(one(`store.append(f.stream, [{ type: 'TicketReleased' }, { type: 'Other' }])`)).toBe(1)
    })
    it('counts a call matching both halves once', () => {
      expect(one(`appendNow(ticketId, [{ type: 'TicketLanded', data: {} }])`)).toBe(1)
    })
    it('does not count RunSpent on a stream argument, or a callee outside APPEND_CALLEES', () => {
      expect(one(`store.append(stream, { type: 'RunSpent', data: {} })`)).toBe(0)
      expect(one(`store.read(ticketId)`)).toBe(0)
      expect(one(`store.append(stream, { data: { type: 'TicketClaimed' } })`)).toBe(0)
    })
    it('does not count a comment', () => {
      expect(one(`// store.append(ticketId, [e])\n/** appendNow(ticketId) */\n`)).toBe(0)
    })
    it('reports the line of the call', () => {
      expect(ticketAppends('a.ts', `const a = 1\n\nstore.append(ticketId, e)\n`)).toEqual([{ line: 3 }])
    })
    it('fails on a file that does not parse, rather than counting it as zero', () => {
      expect(() => ticketAppends('broken.ts', 'store.append(')).toThrow(/broken\.ts:1/)
    })
  })

  describe('which files are read', () => {
    it('never counts the owner, the domain or the event store', () => {
      expect(isCounted('packages/conductor/src/ticket/claim.ts')).toBe(false)
      expect(isCounted('packages/conductor/src/ticket/deep/x.ts')).toBe(false)
      expect(isCounted('packages/domain/src/x.ts')).toBe(false)
      expect(isCounted('packages/event-store/src/x.ts')).toBe(false)
    })
    it('counts any other src file, .tsx included, and nothing outside src', () => {
      expect(isCounted('packages/conductor/src/claim.ts')).toBe(true)
      expect(isCounted('apps/board/src/app/page.tsx')).toBe(true)
      expect(isCounted('packages/conductor/unit/claim.test.ts')).toBe(false)
    })
  })

  describe('compare', () => {
    it('is empty when they agree, a file at zero having no entry', () => {
      expect(compare({ 'a.ts': 2 }, { 'a.ts': 2 })).toEqual([])
      expect(compare({}, {})).toEqual([])
    })
    it('is red, naming the file, on one more than the baseline', () => {
      expect(compare({ 'a.ts': 3 }, { 'a.ts': 2 }).join('\n')).toMatch(/a\.ts has 3 Ticket appends, baseline 2/)
    })
    it('is red on a file the baseline does not list', () => {
      expect(compare({ 'new.ts': 1 }, {}).join('\n')).toMatch(/new\.ts has 1 Ticket append, baseline 0/)
    })
    it('is red, naming the file, on one fewer than the baseline', () => {
      expect(compare({ 'a.ts': 1 }, { 'a.ts': 2 }).join('\n')).toMatch(
        /a\.ts has 1 Ticket append, baseline 2: lower it to 1/,
      )
      expect(compare({}, { 'a.ts': 1 }).join('\n')).toMatch(/lower it to 0 .*remove the entry/)
    })
    it('feeds the rule: one more append than listed is red, one fewer is red', () => {
      const name = 'packages/x/src/a.ts'
      const two = `store.append(ticketId, a)\nstore.append(ticketId, b)\n`
      const measured = (t: string): Record<string, number> => ({ [name]: ticketAppends(name, t).length })
      expect(compare(measured(two), { [name]: 2 })).toEqual([])
      expect(compare(measured(`${two}store.append(ticketId, c)\n`), { [name]: 2 }).join('\n')).toMatch(/a\.ts has 3/)
      expect(compare(measured(`store.append(ticketId, a)\n`), { [name]: 2 }).join('\n')).toMatch(/a\.ts has 1/)
    })
  })

  it('has the stream prefixes as the baseline keys', () => {
    expect(Object.keys(baseline).sort()).toEqual([...PREFIXES].sort())
  })

  it('holds every file at its baseline, and asks for it lowered when below', async () => {
    const measured: Record<string, number> = {}
    for (const top of ['packages', 'apps']) {
      for (const pkg of await readdir(`${root}${top}`, { withFileTypes: true })) {
        if (!pkg.isDirectory()) continue
        let files: string[]
        try {
          files = await walk(`${root}${top}/${pkg.name}/src`)
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue
          throw e
        }
        for (const full of files) {
          const f = full.slice(root.length)
          if (!isCounted(f)) continue
          const n = ticketAppends(f, await readFile(full, 'utf8')).length
          if (n > 0) measured[f] = n
        }
      }
    }
    const problems = compare(measured, baseline['ticket-'])
    if (problems.length > 0) {
      problems.push(`measured now:\n${JSON.stringify({ 'ticket-': measured }, null, 2)}`)
    }
    expect(problems.join('\n\n')).toBe('')
  })
})
