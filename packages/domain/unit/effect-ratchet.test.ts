/**
 * 0101 §6: every backend function that does IO is an Effect, and `Effect.run*`
 * runs only at a host's edge. #790 moves the eleven packages below over one at a
 * time; this holds each package's `async` functions and `Effect.run*`
 * references to only go down (#792).
 *
 * Counted with the TypeScript parser, one `createSourceFile` per file and no
 * `Program` (#785) — a comment that names `runPromise` is not a run.
 *
 * The test never writes the baseline: a unit test that edits the checkout would
 * undo the ratchet. A red prints the JSON value to paste.
 */
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import baseline from './effect-ratchet.baseline.json'

const root = fileURLToPath(new URL('../../../', import.meta.url))

/** 0101 §6's list. Pinned here: a baseline that could drop a key would be a way out. */
const PACKAGES = [
  'apps/cli',
  'packages/event-store',
  'packages/projector',
  'packages/github',
  'packages/repo',
  'packages/agent',
  'packages/actions',
  'packages/conductor',
  'packages/daemon',
  'packages/telegram',
  'packages/setup',
] as const

/** Paths under a counted `src/` that are excluded, each with its reason. Empty today. */
const NOT_COUNTED: readonly { path: string; reason: string }[] = []

interface Hit {
  line: number
}
interface Counts {
  async: Hit[]
  run: Hit[]
}

/**
 * A run that starts a fiber of its own. `Effect.runPromiseWith(services)` and the
 * other `*With` runs are not one: they carry the caller's services, its tracer
 * among them (`Effect.context()`, Effect 4), which is what `Runtime.runPromise(rt)`
 * was on Effect 3 and was never counted.
 */
const RUN = /^run[A-Z](?!\w*With$)/
const EFFECT_MODULES = new Set(['effect', 'effect/Effect'])

/** Parse once; a syntax error comes back as a tree, so read the diagnostics. */
export function parse(name: string, text: string): ts.SourceFile {
  const sf = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true)
  const errors = (sf as unknown as { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics
  if (errors.length > 0) {
    const first = errors[0]!
    const { line } = sf.getLineAndCharacterOfPosition(first.start ?? 0)
    throw new Error(`${name}:${line + 1}: does not parse (${ts.flattenDiagnosticMessageText(first.messageText, ' ')})`)
  }
  return sf
}

export function count(name: string, text: string): Counts {
  const sf = parse(name, text)
  const effects = new Set<string>()
  const bare = new Set<string>()
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue
    const from = st.moduleSpecifier.text
    const clause = st.importClause
    if (!clause || clause.isTypeOnly || !EFFECT_MODULES.has(from)) continue
    if (clause.name && from === 'effect/Effect') effects.add(clause.name.text)
    const nb = clause.namedBindings
    if (nb && ts.isNamespaceImport(nb) && from === 'effect/Effect') effects.add(nb.name.text)
    if (nb && ts.isNamedImports(nb)) {
      for (const el of nb.elements) {
        if (el.isTypeOnly) continue
        const imported = (el.propertyName ?? el.name).text
        if (from === 'effect' && imported === 'Effect') effects.add(el.name.text)
        else if (RUN.test(imported)) bare.add(el.name.text)
      }
    }
  }

  const out: Counts = { async: [], run: [] }
  const at = (n: ts.Node): Hit => ({ line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1 })
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) return
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node)
    ) {
      const mod = ts.getModifiers(node)?.find((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
      if (mod) out.async.push(at(mod))
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      effects.has(node.expression.text) &&
      RUN.test(node.name.text)
    ) {
      out.run.push(at(node))
    } else if (
      ts.isIdentifier(node) &&
      bare.has(node.text) &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
    ) {
      out.run.push(at(node))
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

async function walk(dir: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) found.push(...(await walk(path)))
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) found.push(path)
  }
  return found.sort()
}

describe('the Effect ratchet (0101 §6, #792)', () => {
  it('does not count an async in a comment or a string', () => {
    const c = count('a.ts', `// async function f() {}\nconst s = "async () => 1"\n/* async */\n`)
    expect(c.async).toEqual([])
  })

  it('counts an async arrow, method and function, at the line of the keyword', () => {
    const c = count(
      'a.ts',
      `const a = async () => 1\nclass K {\n  async m() {}\n}\nasync function f() {}\nconst o = { async n() {} }\n`,
    )
    expect(c.async.map((h) => h.line)).toEqual([1, 3, 5, 6])
  })

  it('does not count Effect.runPromise in a comment', () => {
    const c = count('a.ts', `import { Effect } from 'effect'\n// Effect.runPromise(x)\n/** \`runPromise\` */\n`)
    expect(c.run).toEqual([])
  })

  it('counts Effect.run*, including Exit variants', () => {
    const c = count(
      'a.ts',
      `import { Effect } from 'effect'\nEffect.runPromise(a)\nEffect.runSync(b)\nEffect.runPromiseExit(c)\nEffect.runFork(d)\n`,
    )
    expect(c.run).toHaveLength(4)
  })

  it('does not count a run that carries the caller’s services (runPromiseWith, runForkWith)', () => {
    const c = count(
      'a.ts',
      `import { Effect } from 'effect'\nEffect.runPromiseWith(s)(a)\nEffect.runForkWith(s)(b)\nEffect.runSyncExitWith(s)(c)\n`,
    )
    expect(c.run).toEqual([])
  })

  it('counts an aliased runPromise imported from effect', () => {
    const c = count('a.ts', `import { runPromise as go } from 'effect/Effect'\nawait go(x)\n`)
    expect(c.run.map((h) => h.line)).toEqual([2])
    const d = count('b.ts', `import { runPromise as go } from 'effect'\ngo(x)\n`)
    expect(d.run).toHaveLength(1)
  })

  it('counts an aliased Effect and a namespace import', () => {
    expect(count('a.ts', `import { Effect as E } from 'effect'\nE.runSync(x)\n`).run).toHaveLength(1)
    expect(count('b.ts', `import * as E from 'effect/Effect'\nE.runSync(x)\n`).run).toHaveLength(1)
  })

  it('counts a reference that is not a call', () => {
    const c = count('a.ts', `import { Effect } from 'effect'\npipe(x, Effect.runPromise)\n`)
    expect(c.run).toHaveLength(1)
  })

  it('does not count a type-only Effect import', () => {
    const c = count('a.ts', `import { Context, type Effect } from 'effect'\nEffect.runPromise(x)\n`)
    expect(c.run).toEqual([])
    expect(count('b.ts', `import type { Effect } from 'effect'\nEffect.runSync(x)\n`).run).toEqual([])
  })

  it('does not count a run on something that is not Effect', () => {
    const c = count('a.ts', `import { Effect } from 'effect'\nother.runPromise(x)\nx.runSync()\n`)
    expect(c.run).toEqual([])
  })

  it('fails on a file that does not parse, rather than counting it as zero', () => {
    expect(() => count('broken.ts', 'async function (')).toThrow(/broken\.ts:1/)
  })

  it('has the eleven packages of 0101 §6 as the baseline keys', () => {
    expect(Object.keys(baseline).sort()).toEqual([...PACKAGES].sort())
  })

  it('holds every package at or below its baseline, and asks for it lowered when below', async () => {
    const problems: string[] = []
    const measured: Record<string, { async: number; run: number }> = {}
    await Promise.all(
      PACKAGES.map(async (pkg) => {
        const files = (await walk(`${root}${pkg}/src`)).map((f) => f.slice(root.length))
        const skip = NOT_COUNTED.map((n) => n.path)
        const parsed = await Promise.all(
          files
            .filter((f) => !skip.includes(f))
            .map(async (f) => ({ f, c: count(f, await readFile(`${root}${f}`, 'utf8')) })),
        )
        const hits = { async: [] as string[], run: [] as string[] }
        for (const { f, c } of parsed) {
          for (const h of c.async) hits.async.push(`${f}:${h.line}`)
          for (const h of c.run) hits.run.push(`${f}:${h.line}`)
        }
        measured[pkg] = { async: hits.async.length, run: hits.run.length }
        for (const measure of ['async', 'run'] as const) {
          const n = hits[measure].length
          const base = (baseline as Record<string, { async: number; run: number }>)[pkg]?.[measure]
          if (base === undefined) continue
          if (n > base) {
            problems.push(
              `${pkg}.${measure} is ${n}, baseline ${base}:\n${hits[measure].map((h) => `  ${h}`).join('\n')}\n` +
                `0101 §6: every backend function that does IO is an Effect, and \`Effect.run*\` runs only at a host's edge — see epic #790. ` +
                `Write it as an Effect, or raise this number in this diff where a reviewer sees it.`,
            )
          } else if (n < base) {
            problems.push(
              `${pkg}.${measure} is ${n}, baseline ${base}: lower ${pkg}.${measure} to ${n} in effect-ratchet.baseline.json in this change.`,
            )
          }
        }
      }),
    )
    if (problems.length > 0) {
      problems.push(`measured now:\n${JSON.stringify(measured, null, 2)}`)
    }
    expect(problems.join('\n\n')).toBe('')
  })
})
