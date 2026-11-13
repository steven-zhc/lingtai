/**
 * 0101 §6: every backend function that does IO is an Effect, and `Effect.run*`
 * runs only at a host's edge. #790 moves the packages below over one at a
 * time; this holds each package's `async` functions and `Effect.run*`
 * references to only go down (#792).
 *
 * Counted with the TypeScript parser, one `createSourceFile` per file and no
 * `Program` (#785) — a comment that names `runPromise` is not a run.
 *
 * A promise face is not counted. A face is an exported function whose whole body is
 * `return Effect.runPromise(<call>)`, or the generic `return Effect.runPromise(<parameter>, { signal })`,
 * kept for callers not yet moved (#790), and listed in `effect-ratchet.faces.json` with the issue that
 * deletes it. The shape is checked, not trusted: an entry that does anything else, or whose function is
 * gone, is a red. Only `runPromise`: a face that inspects an `Exit` or runs synchronously is a caller
 * doing work, and is counted.
 *
 * The test never writes the baseline: a unit test that edits the checkout would
 * undo the ratchet. A red prints the JSON value to paste.
 */
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import baseline from './effect-ratchet.baseline.json'
import faces from './effect-ratchet.faces.json'

const root = fileURLToPath(new URL('../../../', import.meta.url))

/**
 * 0101 §6's list. Pinned here: a baseline that could drop a key would be a way out.
 * `packages/telegram` is not on it: it is deliberately free of `effect` (`packages/telegram/src/cli.ts:12-17`
 * imports nothing a third party's notifier could not, and `:35-37` says a merge reaches it with no
 * `pnpm install`), so converting it would break both.
 */
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
  'packages/setup',
  'packages/recipe',
] as const

/** Paths under a counted `src/` that are excluded, each with its reason. Empty today. */
const NOT_COUNTED: readonly { path: string; reason: string }[] = []

interface Hit {
  line: number
  /** Where the run's callee text begins, so a face is matched by position and never by line. */
  pos: number
}
interface Counts {
  async: Hit[]
  run: Hit[]
}

/**
 * A run that starts a fiber of its own. `Effect.runPromiseWith(services)` and the
 * other `*With` runs carry the caller's services, its tracer among them
 * (`Effect.context()`, Effect 4), which is what `Runtime.runPromise(rt)` was on
 * Effect 3, and are not counted. A `*With` run whose context is `Context.empty()`
 * or `Context.make(…)` carries nothing: it is a root run under another name, and
 * `RUN_WITH` plus `isEmptyContext` count it.
 */
const RUN = /^run[A-Z](?!\w*With$)/
const RUN_WITH = /^run[A-Z]\w*With$/
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

interface Imports {
  effects: Set<string>
  /** local names of `Context` (from 'effect') or of `effect/Context` itself */
  contexts: Set<string>
  /** local name → the name it was imported as, for `run*With` */
  bareWith: Map<string, string>
  /** local names imported from anywhere else: candidates for a shared empty context */
  others: Map<string, string>
  /** local name → the name it was imported as */
  bare: Map<string, string>
}

function importsOf(sf: ts.SourceFile): Imports {
  const effects = new Set<string>()
  const contexts = new Set<string>()
  const bare = new Map<string, string>()
  const bareWith = new Map<string, string>()
  const others = new Map<string, string>()
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue
    const from = st.moduleSpecifier.text
    const clause = st.importClause
    if (!clause || clause.isTypeOnly) continue
    if (from === 'effect/Context') {
      if (clause.name) contexts.add(clause.name.text)
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings))
        contexts.add(clause.namedBindings.name.text)
      continue
    }
    if (!EFFECT_MODULES.has(from)) {
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) {
          if (!el.isTypeOnly) others.set(el.name.text, (el.propertyName ?? el.name).text)
        }
      }
      continue
    }
    if (clause.name && from === 'effect/Effect') effects.add(clause.name.text)
    const nb = clause.namedBindings
    if (nb && ts.isNamespaceImport(nb) && from === 'effect/Effect') effects.add(nb.name.text)
    if (nb && ts.isNamedImports(nb)) {
      for (const el of nb.elements) {
        if (el.isTypeOnly) continue
        const imported = (el.propertyName ?? el.name).text
        if (from === 'effect' && imported === 'Effect') effects.add(el.name.text)
        else if (from === 'effect' && imported === 'Context') contexts.add(el.name.text)
        else if (RUN.test(imported)) bare.set(el.name.text, imported)
        else if (RUN_WITH.test(imported) && from === 'effect/Effect') bareWith.set(el.name.text, imported)
      }
    }
  }
  return { effects, contexts, bare, bareWith, others }
}

const unwrap = (e: ts.Expression): ts.Expression => {
  let x = e
  while (
    ts.isParenthesizedExpression(x) ||
    ts.isAsExpression(x) ||
    ts.isSatisfiesExpression(x) ||
    ts.isNonNullExpression(x) ||
    ts.isTypeAssertionExpression(x)
  ) {
    x = x.expression
  }
  return x
}

/** `Context.empty()` or `Context.make(…)`, under parentheses, `as`, `satisfies` and `!`. */
function isContextCall(e: ts.Expression, contexts: ReadonlySet<string>): boolean {
  const x = unwrap(e)
  return (
    ts.isCallExpression(x) &&
    ts.isPropertyAccessExpression(x.expression) &&
    ts.isIdentifier(x.expression.expression) &&
    contexts.has(x.expression.expression.text) &&
    (x.expression.name.text === 'empty' || x.expression.name.text === 'make')
  )
}

/** Names this file declares, with `const`, as an empty context: its own, and whether each is exported. */
function emptyContextConsts(
  sf: ts.SourceFile,
  contexts: ReadonlySet<string>,
): { all: Set<string>; exported: Set<string> } {
  const all = new Set<string>()
  const exported = new Set<string>()
  const scan = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isVariableDeclarationList(node.parent) &&
      node.parent.flags & ts.NodeFlags.Const &&
      isContextCall(node.initializer, contexts)
    ) {
      all.add(node.name.text)
      if (ts.isVariableStatement(node.parent.parent) && isExported(node.parent.parent)) exported.add(node.name.text)
    }
    ts.forEachChild(node, scan)
  }
  scan(sf)
  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st) && !st.moduleSpecifier && st.exportClause && ts.isNamedExports(st.exportClause)) {
      for (const el of st.exportClause.elements) {
        if (all.has((el.propertyName ?? el.name).text)) exported.add(el.name.text)
      }
    }
  }
  return { all, exported }
}

/** The names a file exports as an empty context, for the walk's first pass. */
export function emptyContextExports(name: string, text: string): Set<string> {
  const sf = parse(name, text)
  return emptyContextConsts(sf, importsOf(sf).contexts).exported
}

export function count(name: string, text: string, shared: ReadonlySet<string> = new Set()): Counts {
  const sf = parse(name, text)
  const { effects, bare, bareWith, contexts, others } = importsOf(sf)
  const local = emptyContextConsts(sf, contexts).all
  const emptyArg = (e: ts.Expression | undefined): boolean => {
    if (!e) return false
    if (isContextCall(e, contexts)) return true
    const x = unwrap(e)
    if (!ts.isIdentifier(x)) return false
    if (local.has(x.text)) return true
    const from = others.get(x.text)
    return from !== undefined && shared.has(from)
  }

  const out: Counts = { async: [], run: [] }
  const at = (n: ts.Node): Hit => ({
    line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
    pos: n.getStart(sf),
  })
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
      RUN_WITH.test(node.name.text)
    ) {
      if (ts.isCallExpression(node.parent) && node.parent.expression === node && emptyArg(node.parent.arguments[0])) {
        out.run.push(at(node))
      }
    } else if (
      ts.isIdentifier(node) &&
      bareWith.has(node.text) &&
      ts.isCallExpression(node.parent) &&
      node.parent.expression === node
    ) {
      if (emptyArg(node.parent.arguments[0])) out.run.push(at(node))
    } else if (
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

export interface FaceEntry {
  file: string
  fn: string
  until: string
  why: string
}

const isExported = (n: ts.Node): boolean =>
  ts.canHaveModifiers(n) && (ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false)

/**
 * Is `fn` in this file a promise face? Either its one run's position, or why not. The span check reuses
 * `count`, so what a face is allowed to contain and what the package loop counts cannot drift apart.
 */
export function face(name: string, text: string, fn: string): { pos: number } | { refused: string } {
  const sf = parse(name, text)
  const { effects, bare } = importsOf(sf)
  const who = `${name} ${fn}`

  let span: ts.Node | undefined
  let fnNode: ts.FunctionDeclaration | ts.ArrowFunction | undefined
  let unexported = false
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name?.text === fn && st.body) {
      if (isExported(st) && !(ts.getModifiers(st) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) {
        span = st
        fnNode = st
      } else unexported = true
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || d.name.text !== fn) continue
        if (!isExported(st)) unexported = true
        else if (st.declarationList.declarations.length !== 1) {
          return { refused: `${who} is declared beside others in one statement.` }
        } else if (d.initializer && ts.isArrowFunction(d.initializer)) {
          span = st
          fnNode = d.initializer
        } else return { refused: `${who} is not a function declaration or an arrow function.` }
      }
    }
  }
  if (!span || !fnNode) {
    return {
      refused: unexported
        ? `${who} is not exported: a face is \`export function ${fn}\` or \`export const ${fn} = (…) =>\`.`
        : `${name} ${fn}: no exported function \`${fn}\` in this file.`,
    }
  }

  let expr: ts.Expression | undefined
  const body = fnNode.body
  if (!body) return { refused: `${who} has no body.` }
  if (ts.isBlock(body)) {
    if (body.statements.length !== 1) {
      return {
        refused: `${who} is not a promise face: its body has ${body.statements.length} statements. A face is exactly \`return Effect.runPromise(<call>)\` (0101 §6, #790).`,
      }
    }
    const only = body.statements[0]!
    if (!ts.isReturnStatement(only) || !only.expression) {
      return { refused: `${who} is not a promise face: its one statement is not a \`return\` with an expression.` }
    }
    expr = only.expression
  } else expr = body

  if (!ts.isCallExpression(expr)) return { refused: `${who} does not return a call to \`Effect.runPromise\`.` }
  const callee = expr.expression
  let runName: string | undefined
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    effects.has(callee.expression.text)
  ) {
    if (RUN.test(callee.name.text)) runName = callee.name.text
  } else if (ts.isIdentifier(callee) && bare.has(callee.text)) runName = bare.get(callee.text)
  if (runName === undefined) return { refused: `${who} does not return a call to \`Effect.runPromise\`.` }
  if (runName !== 'runPromise') {
    return { refused: `${who} runs \`Effect.${runName}\`. A face runs \`Effect.runPromise\` and nothing else.` }
  }

  const params = new Set(fnNode.parameters.flatMap((p) => (ts.isIdentifier(p.name) ? [p.name.text] : [])))
  if (expr.arguments.length < 1 || expr.arguments.length > 2) {
    return {
      refused: `${who} passes ${expr.arguments.length} arguments to \`Effect.runPromise\`. A face passes the Effect and at most \`{ signal }\`.`,
    }
  }
  const [first, second] = expr.arguments as unknown as readonly [ts.Expression, ts.Expression | undefined]
  const generic = ts.isIdentifier(first) && params.has(first.text)
  if (!generic && !ts.isCallExpression(first)) {
    return { refused: `${who} runs \`${first.getText(sf)}\`, not a call. A face runs the Effect a function returns.` }
  }
  if (second) {
    const props = ts.isObjectLiteralExpression(second) ? second.properties : undefined
    const prop = props?.length === 1 ? props[0]! : undefined
    let value: ts.Expression | undefined
    if (prop && ts.isShorthandPropertyAssignment(prop) && prop.name.text === 'signal') value = prop.name
    else if (prop && ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === 'signal') {
      value = prop.initializer
    }
    if (!value) {
      return {
        refused: `${who} passes \`${second.getText(sf)}\` as the second argument. A face passes \`{ signal }\` or nothing.`,
      }
    }
    if (generic && !(ts.isIdentifier(value) && params.has(value.text))) {
      return { refused: `${who} passes a \`signal\` that is not one of its own parameters.` }
    }
  }

  const pos = callee.getStart(sf)
  const inside = count(name, text).run.filter((h) => h.pos >= span.getStart(sf) && h.pos < span.end)
  const other = inside.find((h) => h.pos !== pos)
  if (other) return { refused: `${who} has a second \`Effect.run*\` at line ${other.line}. A face runs one Effect.` }
  if (inside.length !== 1) return { refused: `${who} has no counted run in its own span.` }
  return { pos }
}

/**
 * The faces file, checked without the filesystem: `read` hands back a file's text or undefined.
 * `exempt` maps a file to the positions of the runs not to count, each to the entry that excuses it.
 */
export function checkFaces(
  entries: unknown,
  read: (file: string) => string | undefined,
): { exempt: Map<string, Map<number, FaceEntry>>; refusals: string[] } {
  const exempt = new Map<string, Map<number, FaceEntry>>()
  const refusals: string[] = []
  const head = 'effect-ratchet.faces.json:'
  if (!Array.isArray(entries)) return { exempt, refusals: [`${head} is not an array.`] }
  const seen = new Set<string>()
  let prev: FaceEntry | undefined
  const skip = NOT_COUNTED.map((n) => n.path)
  for (const [i, raw] of (entries as unknown[]).entries()) {
    const e = raw as Partial<Record<keyof FaceEntry, unknown>> | null
    const str = (k: keyof FaceEntry): string => (typeof e?.[k] === 'string' ? (e[k] as string) : '')
    const entry: FaceEntry = { file: str('file'), fn: str('fn'), until: str('until'), why: str('why') }
    const who = `${head} ${entry.file} ${entry.fn}`
    if (!entry.file || !/^[A-Za-z_$][\w$]*$/.test(entry.fn)) {
      refusals.push(`${head} entry ${i} needs a \`file\` and a \`fn\` that is an identifier.`)
      continue
    }
    if (prev && (entry.file < prev.file || (entry.file === prev.file && entry.fn < prev.fn))) {
      refusals.push(`${who} is out of order: entries are sorted by file, then fn, after ${prev.file} ${prev.fn}.`)
    }
    prev = entry
    if (!/^#\d+$/.test(entry.until)) refusals.push(`${who}: \`until\` must be an issue, as "#790".`)
    if (entry.why.trim() === '') refusals.push(`${who}: \`why\` is empty.`)
    const key = `${entry.file}\0${entry.fn}`
    if (seen.has(key)) {
      refusals.push(`${who} is listed twice.`)
      continue
    }
    seen.add(key)
    if (!PACKAGES.some((p) => entry.file.startsWith(`${p}/src/`)) || skip.includes(entry.file)) {
      refusals.push(`${who} is outside the packages the ratchet counts.`)
      continue
    }
    const text = read(entry.file)
    if (text === undefined) {
      refusals.push(`${who}: no file ${entry.file}.`)
      continue
    }
    const r = face(entry.file, text, entry.fn)
    if ('refused' in r) {
      refusals.push(`${head} ${r.refused}`)
      continue
    }
    const byPos = exempt.get(entry.file) ?? new Map<number, FaceEntry>()
    byPos.set(r.pos, entry)
    exempt.set(entry.file, byPos)
  }
  return { exempt, refusals }
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

  describe('a *With run whose context is empty', () => {
    const H = `import { Context, Effect } from 'effect'\n`
    const n = (t: string, shared?: ReadonlySet<string>): number => count('a.ts', H + t, shared).run.length
    it('counts Context.empty() and Context.make(…), bare and curried', () => {
      expect(n(`Effect.runPromiseWith(Context.empty())\n`)).toBe(1)
      expect(n(`Effect.runPromiseWith(Context.empty())(e)\n`)).toBe(1)
      expect(n(`Effect.runForkWith(Context.make(Tag, x))(e)\n`)).toBe(1)
    })
    it('counts through a same-file const, and under as, satisfies, parentheses and !', () => {
      expect(n(`const c = Context.empty()\nEffect.runSyncWith(c)(e)\n`)).toBe(1)
      expect(n(`Effect.runPromiseWith((Context.empty() as Ctx))(e)\n`)).toBe(1)
      expect(n(`Effect.runPromiseWith(Context.empty() satisfies Ctx)(e)\n`)).toBe(1)
      expect(n(`const c = Context.empty() as Ctx\nEffect.runPromiseWith(c!)(e)\n`)).toBe(1)
    })
    it('counts an aliased Context, effect/Context, and a bare runPromiseWith', () => {
      expect(
        count('a.ts', `import { Context as C, Effect } from 'effect'\nEffect.runPromiseWith(C.empty())\n`).run,
      ).toHaveLength(1)
      expect(
        count(
          'b.ts',
          `import * as C from 'effect/Context'\nimport { Effect } from 'effect'\nEffect.runPromiseWith(C.empty())\n`,
        ).run,
      ).toHaveLength(1)
      expect(
        count(
          'c.ts',
          `import { Context } from 'effect'\nimport { runPromiseWith } from 'effect/Effect'\nrunPromiseWith(Context.empty())(e)\n`,
        ).run,
      ).toHaveLength(1)
    })
    it('counts a const exported from another counted file', () => {
      const lib = `import { Context } from 'effect'\nexport const none = Context.empty()\nconst x = Context.empty()\nexport { x }\n`
      const shared = emptyContextExports('lib.ts', lib)
      expect([...shared].sort()).toEqual(['none', 'x'])
      const user = `import { Effect } from 'effect'\nimport { none } from './lib'\nEffect.runPromiseWith(none)(e)\n`
      expect(count('user.ts', user, shared).run).toHaveLength(1)
      expect(count('user.ts', user).run).toHaveLength(0)
    })
    it('does not count a context taken from the caller, directly or under a ternary', () => {
      expect(
        n(
          `const f = Effect.gen(function* () {\n  const services = yield* Effect.context<never>()\n  Effect.runPromiseWith(services)(e)\n})\n`,
        ),
      ).toBe(0)
      expect(
        n(
          `const f = Effect.gen(function* () {\n  const runtime = opts.slots ? yield* Effect.context<R>() : undefined\n  Effect.runPromiseWith(runtime!)(e)\n})\n`,
        ),
      ).toBe(0)
    })
    it('does not count a let, a parameter or a property', () => {
      expect(n(`let s = Context.empty()\ns = yield* Effect.context()\nEffect.runPromiseWith(s)(e)\n`)).toBe(0)
      expect(n(`const f = (s: Ctx) => Effect.runPromiseWith(s)(e)\nEffect.runForkWith(ports.services)(e)\n`)).toBe(0)
    })
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

  describe('face', () => {
    const E = `import { Effect } from 'effect'\n`
    const pos = (text: string, needle: string): number => text.indexOf(needle)
    const refused = (text: string, fn = 'f'): string => {
      const r = face('y.ts', text, fn)
      if (!('refused' in r)) throw new Error('expected a refusal')
      return r.refused
    }

    it('accepts a function returning one runPromise over a call, at the position of the callee', () => {
      const t = `${E}export function f() { return Effect.runPromise(g()) }\n`
      expect(face('y.ts', t, 'f')).toEqual({ pos: pos(t, 'Effect.runPromise') })
    })
    it('accepts an exported arrow, an aliased runPromise, and a call on a property', () => {
      const a = `${E}export const f = (x) => Effect.runPromise(g(x))\n`
      expect(face('y.ts', a, 'f')).toEqual({ pos: pos(a, 'Effect.runPromise') })
      const b = `import { runPromise as go } from 'effect/Effect'\nexport function f() { return go(g()) }\n`
      expect(face('y.ts', b, 'f')).toEqual({ pos: pos(b, 'go(') })
      expect(face('y.ts', `${E}export function f(e) { return Effect.runPromise(e.append(x)) }`, 'f')).toHaveProperty(
        'pos',
      )
    })
    it('accepts { signal } and { signal: options.signal } as a second argument, and nothing else', () => {
      expect(
        face('y.ts', `${E}export function f(signal) { return Effect.runPromise(g(x), { signal }) }`, 'f'),
      ).toHaveProperty('pos')
      expect(
        face(
          'y.ts',
          `${E}export function f(options) { return Effect.runPromise(g(x), { signal: options.signal }) }`,
          'f',
        ),
      ).toHaveProperty('pos')
      expect(refused(`${E}export function f(signal) { return Effect.runPromise(g(x), { signal, other }) }`)).toMatch(
        /second argument/,
      )
      expect(refused(`${E}export function f(o) { return Effect.runPromise(g(x), o) }`)).toMatch(/second argument/)
      expect(refused(`${E}export function f() { return Effect.runPromise(g(x), { signal }, 3) }`)).toMatch(
        /3 arguments/,
      )
    })
    it('accepts a generic face over its own parameters, and refuses one that is not', () => {
      expect(
        face(
          'y.ts',
          `${E}export function f<A>(effect: Effect.Effect<A>, signal?: AbortSignal) { return Effect.runPromise(effect, { signal }) }`,
          'f',
        ),
      ).toHaveProperty('pos')
      expect(refused(`${E}export function f(effect) { return Effect.runPromise(program) }`)).toMatch(/not a call/)
      expect(
        refused(`${E}export function f(effect, s) { return Effect.runPromise(effect, { signal: other }) }`),
      ).toMatch(/own parameters/)
      expect(refused(`${E}export function f(effect, s) { return Effect.runPromise(effect, { other: s }) }`)).toMatch(
        /second argument/,
      )
    })
    it('refuses a second statement and names the count', () => {
      expect(refused(`${E}export async function f() { const r = await Effect.runPromise(g()); return r }`)).toMatch(
        /2 statements/,
      )
    })
    it('refuses runPromiseExit and runSync by name, even aliased', () => {
      expect(refused(`${E}export function f() { return Effect.runPromiseExit(g()) }`)).toMatch(/runPromiseExit/)
      expect(refused(`${E}export function f() { return Effect.runSync(g()) }`)).toMatch(/runSync/)
      expect(refused(`import { runSync as go } from 'effect/Effect'\nexport function f() { return go(g()) }`)).toMatch(
        /runSync/,
      )
    })
    it('refuses an identifier that is not a parameter', () => {
      expect(refused(`${E}export function f() { return Effect.runPromise(program) }`)).toMatch(/not a call/)
    })
    it('refuses a second run inside and names its line', () => {
      const t = `${E}export function f() {\n  return Effect.runPromise(g(Effect.runSync(h)))\n}\n`
      expect(refused(t)).toMatch(/second `Effect.run\*` at line 3/)
    })
    it('refuses a function that is not exported, an export list, and a missing fn', () => {
      expect(refused(`${E}function f() { return Effect.runPromise(g()) }`)).toMatch(/not exported/)
      expect(refused(`${E}function f() { return Effect.runPromise(g()) }\nexport { f }`)).toMatch(/not exported/)
      expect(refused(`${E}export function other() { return Effect.runPromise(g()) }`)).toMatch(/no exported function/)
    })
    it('still counts a run on the same line but outside the face', () => {
      const t = `${E}export const f = () => Effect.runPromise(g()); Effect.runSync(h)\n`
      const r = face('y.ts', t, 'f')
      if (!('pos' in r)) throw new Error('expected a face')
      const others = count('y.ts', t).run.filter((h) => h.pos !== r.pos)
      expect(others).toHaveLength(1)
    })
  })

  describe('checkFaces', () => {
    const src: Record<string, string> = {
      'packages/repo/src/a.ts': `import { Effect } from 'effect'\nexport function f() { return Effect.runPromise(g()) }\n`,
    }
    const read = (f: string): string | undefined => src[f]
    const ok = { file: 'packages/repo/src/a.ts', fn: 'f', until: '#790', why: 'callers' }
    const run = (entries: unknown): string => checkFaces(entries, read).refusals.join('\n')

    it('accepts a good entry and exempts the position of its run', () => {
      const r = checkFaces([ok], read)
      expect(r.refusals).toEqual([])
      expect(r.exempt.get(ok.file)?.size).toBe(1)
    })
    it('refuses, each by name, an outside-the-packages entry, a bad until, an empty why and a duplicate', () => {
      expect(run([{ ...ok, file: 'packages/domain/src/z.ts' }])).toMatch(
        /z\.ts f is outside the packages the ratchet counts/,
      )
      expect(run([{ ...ok, file: 'packages/telegram/src/z.ts' }])).toMatch(/outside the packages the ratchet counts/)
      expect(run([{ ...ok, until: '790' }])).toMatch(/`until` must be an issue/)
      expect(run([{ ...ok, why: ' ' }])).toMatch(/`why` is empty/)
      expect(run([ok, ok])).toMatch(/listed twice/)
      expect(run([{ ...ok, file: 'packages/repo/src/missing.ts' }])).toMatch(/no file/)
      expect(run('nope')).toMatch(/not an array/)
    })
    it('refuses an entry out of order', () => {
      expect(run([{ ...ok, fn: 'g' }, ok])).toMatch(/out of order/)
    })
  })

  it('has the counted packages as the baseline keys', () => {
    expect(Object.keys(baseline).sort()).toEqual([...PACKAGES].sort())
  })

  it('holds every package at or below its baseline, and asks for it lowered when below', async () => {
    const listed = Array.isArray(faces) ? (faces as { file?: unknown }[]).map((e) => e?.file) : []
    const texts = new Map<string, string>()
    for (const f of listed) {
      if (typeof f !== 'string' || texts.has(f)) continue
      try {
        texts.set(f, await readFile(`${root}${f}`, 'utf8'))
      } catch {
        // a missing file is a refusal by name, in checkFaces
      }
    }
    const { exempt, refusals } = checkFaces(faces, (f) => texts.get(f))
    const problems: string[] = [...refusals]
    const notCounted: string[] = []
    const measured: Record<string, { async: number; run: number }> = {}
    const skip = NOT_COUNTED.map((n) => n.path)
    const sources = new Map<string, string>()
    for (const pkg of PACKAGES) {
      for (const full of await walk(`${root}${pkg}/src`)) {
        const f = full.slice(root.length)
        if (!skip.includes(f)) sources.set(f, await readFile(full, 'utf8'))
      }
    }
    const shared = new Set<string>()
    for (const [f, text] of sources) for (const x of emptyContextExports(f, text)) shared.add(x)
    await Promise.all(
      PACKAGES.map(async (pkg) => {
        const parsed = [...sources]
          .filter(([f]) => f.startsWith(`${pkg}/src/`))
          .map(([f, text]) => ({ f, c: count(f, text, shared) }))
        const hits = { async: [] as string[], run: [] as string[] }
        for (const { f, c } of parsed) {
          for (const h of c.async) hits.async.push(`${f}:${h.line}`)
          for (const h of c.run) {
            const entry = exempt.get(f)?.get(h.pos)
            if (entry) notCounted.push(`${f}:${h.line} ${entry.fn} (until ${entry.until})`)
            else hits.run.push(`${f}:${h.line}`)
          }
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
                `Write it as an Effect. A promise face kept for callers not yet moved is listed in effect-ratchet.faces.json, and is never paid for by raising this number.`,
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
      if (notCounted.length > 0)
        problems.push(
          `not counted, listed as promise faces:\n${notCounted
            .sort()
            .map((l) => `  ${l}`)
            .join('\n')}`,
        )
    }
    expect(problems.join('\n\n')).toBe('')
  })
})
