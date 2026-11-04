/**
 * 0101 §4 / #797: a stream's reducer exists once, in `@lingtai/domain`. This
 * counts every event-type branch in `src/` outside domain and holds the set to
 * a committed list, in both directions (#846).
 *
 * Counted with the TypeScript parser, one `createSourceFile` per file (as
 * `effect-ratchet.test.ts` does) — a comment that names `RunStarted` is not a
 * branch. The test never writes the list: a unit test that edits the checkout
 * would undo the ratchet. A red prints the whole corrected list to paste, and
 * a pasted entry still needs its `reason` written by hand.
 *
 * Out of scope on purpose: a `Set` of type names, `includes(e.type)` and a
 * lookup table keyed by type. Routing by stream (`isAttemptStream`,
 * `isBacklogStream`) is the allowed shape and is not counted.
 */
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import allowlist from './one-reducer.allowlist.json'

const root = fileURLToPath(new URL('../../../', import.meta.url))

/** The two trees walked. Pinned here: a package added under either is counted with no edit. */
const TREES = ['apps', 'packages'] as const
const SKIPPED_DIRS = new Set(['node_modules', '.next', 'dist'])
/** The one path whose branches are the reducers themselves. */
const DOMAIN_SRC = 'packages/domain/src'

const CLASSES = ['join', 'reaction', 'select'] as const

interface Entry {
  file: string
  function: string
  type: string
  count: number
  class: string
  reason: string
}

type Key = Pick<Entry, 'file' | 'function' | 'type'>
const keyOf = (k: Key): string => `${k.file}\u0000${k.function}\u0000${k.type}`

async function eventNames(): Promise<Set<string>> {
  const path = `${root}doc/events.json`
  const parsed = JSON.parse(await readFile(path, 'utf8')) as { events?: { name: string }[] }
  if (!Array.isArray(parsed.events) || parsed.events.length === 0) throw new Error(`${path}: holds no events`)
  return new Set(parsed.events.map((e) => e.name))
}

function parse(name: string, text: string): ts.SourceFile {
  const sf = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true)
  const errors = (sf as unknown as { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics
  if (errors.length > 0) {
    const first = errors[0]!
    const { line } = sf.getLineAndCharacterOfPosition(first.start ?? 0)
    throw new Error(`${name}:${line + 1}: does not parse (${ts.flattenDiagnosticMessageText(first.messageText, ' ')})`)
  }
  return sf
}

const stringOf = (n: ts.Node): string | null =>
  ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ? n.text : null

const isTypeAccess = (n: ts.Node): boolean =>
  (ts.isIdentifier(n) && n.text === 'type') || (ts.isPropertyAccessExpression(n) && n.name.text === 'type')

const isFunctionLike = (n: ts.Node | undefined): boolean =>
  n !== undefined && (ts.isArrowFunction(n) || ts.isFunctionExpression(n))

/** The nearest enclosing named thing, or `<module>`. */
function enclosing(node: ts.Node): string {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name) return p.name.getText()
    if ((ts.isPropertyDeclaration(p) || ts.isPropertyAssignment(p)) && isFunctionLike(p.initializer))
      return p.name.getText()
    if (ts.isVariableDeclaration(p) && isFunctionLike(p.initializer)) return p.name.getText()
  }
  return '<module>'
}

/** Every event-type branch in one file, as `function` + `type` keys with counts. */
export function branchesIn(file: string, text: string, names: ReadonlySet<string>): Map<string, Entry> {
  const sf = parse(file, text)
  const out = new Map<string, Entry>()
  const hit = (node: ts.Node, type: string): void => {
    const key = { file, function: enclosing(node), type }
    const at = keyOf(key)
    const seen = out.get(at)
    if (seen) seen.count += 1
    else out.set(at, { ...key, count: 1, class: '', reason: '' })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCaseClause(node)) {
      const t = stringOf(node.expression)
      if (t !== null && names.has(t)) hit(node, t)
    } else if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
    ) {
      const l = stringOf(node.left)
      const r = stringOf(node.right)
      if (l !== null && names.has(l) && isTypeAccess(node.right)) hit(node, l)
      else if (r !== null && names.has(r) && isTypeAccess(node.left)) hit(node, r)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

async function walk(dir: string, rel: string, into: string[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) continue
    const path = `${rel}/${entry.name}`
    if (path === DOMAIN_SRC) continue
    if (entry.isDirectory()) await walk(`${dir}/${entry.name}`, path, into)
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) into.push(path)
  }
}

/** Every `.ts` and `.tsx` under a `src/` in `apps/*` and `packages/*`. */
async function sourceFiles(): Promise<string[]> {
  const found: string[] = []
  for (const tree of TREES) {
    for (const pkg of await readdir(`${root}${tree}`, { withFileTypes: true })) {
      if (!pkg.isDirectory() || SKIPPED_DIRS.has(pkg.name)) continue
      const src = `${tree}/${pkg.name}/src`
      if (src === DOMAIN_SRC) continue
      const entries = await readdir(`${root}${src}`).catch(() => null)
      if (entries === null) continue
      await walk(`${root}${src}`, src, found)
    }
  }
  if (found.length === 0) throw new Error('found no source files under apps/*/src or packages/*/src')
  return found.sort()
}

const order = (a: Entry, b: Entry): number =>
  a.file < b.file
    ? -1
    : a.file > b.file
      ? 1
      : a.function < b.function
        ? -1
        : a.function > b.function
          ? 1
          : a.type < b.type
            ? -1
            : a.type > b.type
              ? 1
              : 0

describe('no reducer outside domain branches on an event type (#846)', () => {
  const listed = allowlist as Entry[]

  it('counts a case, a === and a !==, and nothing in a comment', () => {
    const names = new Set(['RunStarted', 'WaitStarted'])
    const text = [
      `// case 'RunStarted':`,
      `function f(e: { type: string }) {`,
      `  switch (e.type) { case 'RunStarted': return 1 }`,
      `  if (e.type === 'WaitStarted' || 'WaitStarted' !== e.type) return 2`,
      `  if (e.kind === 'RunStarted' || e.type === 'Other') return 3`,
      `}`,
      `const g = ({ type }: { type: string }) => type === 'RunStarted'`,
      ``,
    ].join('\n')
    const got = [...branchesIn('a.ts', text, names).values()].map((b) => `${b.function} ${b.type} ${b.count}`)
    expect(got.sort()).toEqual(['f RunStarted 1', 'f WaitStarted 2', 'g RunStarted 1'])
  })

  it('names an object-literal method and a property arrow by their own name', () => {
    const names = new Set(['RunStarted'])
    const text = `const p = { async apply(es: { type: string }[]) { for (const e of es) { if (e.type === 'RunStarted') {} } }, deliver: (e: { type: string }) => e.type === 'RunStarted' }\n`
    const got = [...branchesIn('a.ts', text, names).values()].map((b) => b.function)
    expect(got.sort()).toEqual(['apply', 'deliver'])
  })

  it('parses a .tsx file', () => {
    const names = new Set(['RunStarted'])
    const got = branchesIn(
      'a.tsx',
      `export const A = (e: { type: string }) => <b>{e.type === 'RunStarted'}</b>\n`,
      names,
    )
    expect([...got.values()].map((b) => b.function)).toEqual(['A'])
  })

  it('holds every branch the code has, and every entry has a branch', async () => {
    const names = await eventNames()
    const code = new Map<string, Entry>()
    for (const file of await sourceFiles()) {
      for (const [k, v] of branchesIn(file, await readFile(`${root}${file}`, 'utf8'), names)) code.set(k, v)
    }

    const keys = new Set<string>()
    for (const e of listed) {
      const k = keyOf(e)
      expect(keys.has(k), `two entries with one key: ${e.file} ${e.function} ${e.type}`).toBe(false)
      keys.add(k)
    }

    const byKey = new Map(listed.map((e) => [keyOf(e), e]))
    const corrected: Entry[] = []
    let drift = false
    for (const [k, found] of code) {
      const have = byKey.get(k)
      if (!have) drift = true
      else if (have.count !== found.count) drift = true
      corrected.push({ ...found, class: have?.class ?? '', reason: have?.reason ?? '' })
    }
    for (const k of byKey.keys()) if (!code.has(k)) drift = true
    corrected.sort(order)

    expect(
      drift,
      `the list and the code disagree. Paste this, then write each empty "reason":\n${JSON.stringify(corrected, null, 2)}\n`,
    ).toBe(false)
  })

  it('gives every entry a class, a function and a reason', () => {
    for (const e of listed) {
      const at = `${e.file} ${e.function} ${e.type}`
      expect(e.function, `${at}: function`).not.toBe('')
      expect(CLASSES as readonly string[], `${at}: class`).toContain(e.class)
      expect(e.reason.trim(), `${at}: reason`).not.toBe('')
      expect(Number.isInteger(e.count) && e.count > 0, `${at}: count`).toBe(true)
    }
  })

  it('keeps the list in the order a red prints it', () => {
    expect([...listed].sort(order)).toEqual(listed)
  })
})
