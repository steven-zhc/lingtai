/**
 * 0101 §6: every backend function that does IO is an Effect, and `Effect.run*`
 * runs only at a host's edge. #790 has ended: every package below is held at
 * 0/0, and this keeps each package's `async` functions and `Effect.run*`
 * references from rising again (#792).
 *
 * Counted with the TypeScript parser, one `createSourceFile` per file and no
 * `Program` (#785) — a comment that names `runPromise` is not a run.
 *
 * A promise face is not counted. A face is an exported function whose whole body is
 * `return Effect.runPromise(<call>)`, or the generic `return Effect.runPromise(<parameter>, { signal })`,
 * kept where a host reads through it (`0101 §7`) or under a named issue still open, and listed in
 * `effect-ratchet.faces.json` with which. The shape is checked, not trusted: an entry that does anything else, or whose function is
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
 * `pnpm install`), so converting it would break both. Decided when #790 ended (#1116): it stays off the list.
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
  'packages/sandbox',
] as const

/**
 * A file under a counted `src/` that the package total leaves out, with the counts it has. The counts are
 * measured, not trusted: the ratchet still counts the file and is red when either differs, in either direction.
 * **Adding a path to `NOT_COUNTED` or `HOST_EDGES`, or raising a count in one, is raising the baseline.**
 */
export interface Exclusion {
  path: string
  async: number
  run: number
  reason: string
  /** When set, every module the file loads must satisfy it, and the red names the one that does not. */
  imports?: (specifier: string) => boolean
}

/** `notify.ts` imports `node:` and the extension's index, and nothing else, so it starts with no database or credentials. */
const NOTIFY_IMPORTS = '../../../packages/extension/src/index.ts'
const notifyMayImport = (specifier: string): boolean => specifier.startsWith('node:') || specifier === NOTIFY_IMPORTS

/** Files that are never Effects by design. */
const NOT_COUNTED: readonly Exclusion[] = [
  {
    path: 'apps/cli/src/prompt.ts',
    async: 5,
    run: 0,
    reason: 'the @clack/prompts wrapper; kept promise-shaped by the operator, 2026-11-12',
  },
  {
    path: 'apps/cli/src/notify.ts',
    async: 5,
    run: 0,
    reason:
      'an extension run as its own process, importing only node: and packages/extension, as packages/telegram does',
    imports: notifyMayImport,
  },
]

/** Where the program's own run is: a host's edge (0101 §6). */
const HOST_EDGES: readonly Exclusion[] = [
  { path: 'apps/cli/src/entry.ts', async: 0, run: 1, reason: "the program's one run (0101 §6)" },
]

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

/** The files under `apps/board` and `apps/site` a face's `why` names, each as the path without its `:line`. */
export function hostPaths(why: string): string[] {
  return [...why.matchAll(/apps\/(?:board|site)\/[\w@./()[\]-]*[\w)\]]/g)].map((m) => m[0])
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
  const skip = [...NOT_COUNTED, ...HOST_EDGES].map((n) => n.path)
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
    if (entry.until === '0101 §7') {
      // The board and the site keep promises for good (0101 §7), so this `until` is true only of a face a host
      // file reaches. A `why` naming `packages/…` alone is a test's reason, and a test is not a host.
      const hosts = hostPaths(entry.why)
      if (hosts.length === 0) {
        refusals.push(`${who}: \`until\` "0101 §7" needs a \`why\` that names a file under apps/board or apps/site.`)
      }
      for (const h of hosts) {
        if (read(h) === undefined) refusals.push(`${who}: \`why\` names ${h}, which does not exist.`)
      }
    } else if (!/^#\d+$/.test(entry.until)) {
      refusals.push(`${who}: \`until\` must be an issue, as "#1118", or "0101 §7" for a face a host reads.`)
    }
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

/** Every module a file names: `import`, `export … from`, `import(…)`, `require(…)`, `import x = require(…)`, `import('x').T`. */
export function modulesOf(name: string, text: string): { specifier: string; line: number }[] {
  const sf = parse(name, text)
  const found: { specifier: string; line: number }[] = []
  const at = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
  const note = (n: ts.Node, arg: ts.Node | undefined): void => {
    found.push({
      specifier: arg && ts.isStringLiteralLike(arg) ? arg.text : `<${arg ? arg.getText(sf) : 'nothing'}>`,
      line: at(n),
    })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier)) {
      note(node, node.moduleSpecifier)
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      note(node, node.moduleReference.expression)
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      note(node, node.argument.literal)
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      note(node, node.arguments[0])
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

/**
 * The exclusion lists, checked without the filesystem: `read` hands back a file's text or undefined. Each entry
 * is counted with the ratchet's own `count` and must match exactly; a file that names its imports is held to them.
 */
export function checkExclusions(
  lists: readonly { name: string; entries: readonly Exclusion[] }[],
  read: (file: string) => string | undefined,
  shared: ReadonlySet<string>,
): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const { name, entries } of lists) {
    for (const e of entries) {
      const who = `${name} ${e.path}`
      if (seen.has(e.path)) problems.push(`${who} is listed twice.`)
      seen.add(e.path)
      if (!PACKAGES.some((p) => e.path.startsWith(`${p}/src/`))) {
        problems.push(`${who} is outside the packages the ratchet counts.`)
        continue
      }
      if (e.reason.trim() === '') problems.push(`${who}: \`reason\` is empty.`)
      const text = read(e.path)
      if (text === undefined) {
        problems.push(`${who}: no file ${e.path}.`)
        continue
      }
      const c = count(e.path, text, shared)
      for (const measure of ['async', 'run'] as const) {
        if (c[measure].length !== e[measure]) {
          problems.push(
            `${who}.${measure} is ${c[measure].length}, listed as ${e[measure]}: the listed count is measured and must match. ` +
              `Adding to ${name}, or raising a count in it, is raising the baseline.`,
          )
        }
      }
      for (const m of e.imports ? modulesOf(e.path, text) : []) {
        if (!e.imports!(m.specifier)) {
          problems.push(`${who}:${m.line} imports \`${m.specifier}\`, which this file may not: ${e.reason}.`)
        }
      }
    }
  }
  return problems
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

/**
 * A listed face that nothing references. `sources` is every `.ts`/`.tsx` under `apps/` and `packages/`; a
 * reference is an identifier token spelled `fn` in code — a comment or a string is not one, the JSON is not
 * TypeScript, and the entry's own declaration (its `function` name or `const` name in `entry.file`) is not
 * one either. A call in the declaring file counts: most faces are reached through a sibling in their own file.
 */
export function unreferencedFaces(entries: readonly FaceEntry[], sources: ReadonlyMap<string, string>): string[] {
  const parsed = new Map<string, ts.SourceFile>()
  const tree = (file: string): ts.SourceFile | undefined => {
    const text = sources.get(file)
    if (text === undefined) return undefined
    if (!parsed.has(file)) parsed.set(file, parse(file, text))
    return parsed.get(file)
  }
  const refused: string[] = []
  for (const entry of entries) {
    let found = false
    for (const [file, text] of sources) {
      if (!text.includes(entry.fn)) continue
      const sf = tree(file)
      if (sf === undefined) continue
      const visit = (node: ts.Node): void => {
        if (found) return
        if (ts.isIdentifier(node) && node.text === entry.fn) {
          const p = node.parent
          const declaration =
            file === entry.file &&
            ((ts.isFunctionDeclaration(p) && p.name === node) || (ts.isVariableDeclaration(p) && p.name === node))
          if (!declaration) found = true
        }
        ts.forEachChild(node, visit)
      }
      visit(sf)
      if (found) break
    }
    if (!found) {
      refused.push(
        `effect-ratchet.faces.json: ${entry.file} ${entry.fn} has no reference in apps/ or packages/ besides its declaration — delete the face and its entry.`,
      )
    }
  }
  return refused
}

async function walkSources(dir: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) found.push(...(await walkSources(path)))
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
    it('accepts "0101 §7" on a why that names an existing host file, and refuses it otherwise', () => {
      const host = 'apps/board/src/lib/board.ts'
      const withHost = (f: string): string | undefined => (f === host ? 'export {}' : src[f])
      const board = { ...ok, until: '0101 §7', why: `${host}:1505 holds the promise store` }
      expect(checkFaces([board], withHost).refusals).toEqual([])
      expect(checkFaces([board], read).refusals.join('\n')).toMatch(
        /names apps\/board\/src\/lib\/board\.ts, which does not exist/,
      )
      expect(run([{ ...board, why: 'packages/conductor/src/x.ts and the tests' }])).toMatch(
        /names a file under apps\/board/,
      )
      expect(run([{ ...board, why: ' ' }])).toMatch(/`why` is empty/)
      expect(
        checkFaces([{ ...board, why: 'apps/site/scripts/books.ts' }], (f) =>
          f === 'apps/site/scripts/books.ts' ? '' : src[f],
        ).refusals,
      ).toEqual([])
    })
    it('refuses an entry out of order', () => {
      expect(run([{ ...ok, fn: 'g' }, ok])).toMatch(/out of order/)
    })
  })

  describe('unreferencedFaces', () => {
    const entry = (fn: string, file = 'packages/repo/src/a.ts'): FaceEntry => ({ file, fn, until: '0101 §7', why: 'x' })
    const decl = `export const f = () => Effect.runPromise(g())\n`
    it('refuses, by name, an entry only its declaration, a comment and a string mention', () => {
      const sources = new Map([
        ['packages/repo/src/a.ts', `${decl}// f is called by nobody\nconst s = "f()"\n`],
        ['packages/repo/src/b.ts', `/** f */\nexport const h = 1\n`],
      ])
      expect(unreferencedFaces([entry('f')], sources)).toEqual([
        'effect-ratchet.faces.json: packages/repo/src/a.ts f has no reference in apps/ or packages/ besides its declaration — delete the face and its entry.',
      ])
    })
    it('counts a call in the declaring file and a call from another file', () => {
      const same = new Map([['packages/repo/src/a.ts', `${decl}export const k = () => f()\n`]])
      expect(unreferencedFaces([entry('f')], same)).toEqual([])
      const other = new Map([
        ['packages/repo/src/a.ts', decl],
        ['apps/cli/src/b.ts', `import { f } from '@lingtai/repo/a'\nvoid f()\n`],
      ])
      expect(unreferencedFaces([entry('f')], other)).toEqual([])
    })
    it('counts a function declaration as a declaration, not a reference', () => {
      const sources = new Map([['packages/repo/src/a.ts', `export function f() { return Effect.runPromise(g()) }\n`]])
      expect(unreferencedFaces([entry('f')], sources)).toHaveLength(1)
    })
  })

  describe('checkExclusions', () => {
    const E = `import { Effect } from 'effect'\n`
    const path = 'apps/cli/src/x.ts'
    const entry: Exclusion = { path, async: 2, run: 0, reason: 'why' }
    const check = (text: string | undefined, e: Exclusion = entry): string =>
      checkExclusions([{ name: 'NOT_COUNTED', entries: [e] }], (f) => (f === path ? text : undefined), new Set()).join(
        '\n',
      )
    const two = 'async function a() {}\nasync function b() {}\n'

    it('accepts a file whose counts are the listed ones', () => {
      expect(check(two)).toBe('')
      expect(check(`${E}Effect.runPromise(g())\n`, { ...entry, async: 0, run: 1 })).toBe('')
    })
    it('is red on a sixth async where five are listed, and on one fewer', () => {
      expect(check(`${two}async function c() {}\n`)).toMatch(/x\.ts\.async is 3, listed as 2/)
      expect(check('async function a() {}\n')).toMatch(/x\.ts\.async is 1, listed as 2/)
    })
    it('is red on a second run in a host edge', () => {
      const edge = { ...entry, async: 0, run: 1 }
      expect(check(`${E}Effect.runPromise(g())\nEffect.runPromise(h())\n`, edge)).toMatch(/\.run is 2, listed as 1/)
      expect(check('export {}\n', edge)).toMatch(/\.run is 0, listed as 1/)
    })
    it('says that adding to a list is raising the baseline', () => {
      expect(check(`${two}async function c() {}\n`)).toMatch(/is raising the baseline/)
    })
    it('refuses a path outside the counted packages, a missing file and a listing twice', () => {
      expect(check(two, { ...entry, path: 'packages/telegram/src/x.ts' })).toMatch(/outside the packages/)
      expect(check(undefined)).toMatch(/no file/)
      expect(checkExclusions([{ name: 'A', entries: [entry, entry] }], () => two, new Set()).join('\n')).toMatch(
        /listed twice/,
      )
    })
    it('holds a file to its imports, and names the one that is not allowed and its line', () => {
      const imports = (s: string): boolean => s.startsWith('node:') || s === 'ok'
      const e = { ...entry, async: 0, imports }
      expect(check(`import { a } from 'node:fs'\nimport type { B } from 'ok'\n`, e)).toBe('')
      expect(check(`import { a } from 'node:fs'\nimport { Effect } from 'effect'\n`, e)).toMatch(
        /x\.ts:2 imports `effect`/,
      )
    })
    it('finds an import however it is spelled', () => {
      const t = [
        `export { a } from 'one'`,
        `const b = await import('two')`,
        `const c = require('three')`,
        `import d = require('four')`,
        `type T = import('five').T`,
        `import('./' + x)`,
      ].join('\n')
      expect(modulesOf('y.ts', t).map((m) => m.specifier)).toEqual([
        'one',
        'two',
        'three',
        'four',
        'five',
        "<'./' + x>",
      ])
    })
    it("holds notify.ts to node: and the extension's index", () => {
      expect(notifyMayImport('node:child_process')).toBe(true)
      expect(notifyMayImport(NOTIFY_IMPORTS)).toBe(true)
      expect(notifyMayImport('effect')).toBe(false)
      expect(notifyMayImport('@lingtai/event-store')).toBe(false)
      expect(notifyMayImport('../../../packages/extension/src/other.ts')).toBe(false)
    })
  })

  it('lists no face that nothing references', async () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url))
    const sources = new Map<string, string>()
    for (const top of ['apps', 'packages']) {
      for (const full of await walkSources(`${root}${top}`)) {
        sources.set(full.slice(root.length), await readFile(full, 'utf8'))
      }
    }
    expect(unreferencedFaces(faces as FaceEntry[], sources)).toEqual([])
  })

  it('has no face waiting on #790, which has ended', () => {
    const waiting = (faces as { file: string; fn: string; until: string }[])
      .filter((e) => e.until === '#790')
      .map((e) => `${e.file} ${e.fn}`)
    expect(waiting).toEqual([])
  })

  it('has the counted packages as the baseline keys', () => {
    expect(Object.keys(baseline).sort()).toEqual([...PACKAGES].sort())
  })

  it('holds every package at or below its baseline, and asks for it lowered when below', async () => {
    const listed = Array.isArray(faces) ? (faces as { file?: unknown }[]).map((e) => e?.file) : []
    const texts = new Map<string, string>()
    const named = Array.isArray(faces)
      ? (faces as { why?: unknown }[]).flatMap((e) => hostPaths(String(e?.why ?? '')))
      : []
    for (const f of [...listed, ...named]) {
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
    const excluded = new Set([...NOT_COUNTED, ...HOST_EDGES].map((n) => n.path))
    const sources = new Map<string, string>()
    for (const pkg of PACKAGES) {
      for (const full of await walk(`${root}${pkg}/src`)) {
        const f = full.slice(root.length)
        sources.set(f, await readFile(full, 'utf8'))
      }
    }
    const shared = new Set<string>()
    for (const [f, text] of sources) for (const x of emptyContextExports(f, text)) shared.add(x)
    problems.push(
      ...checkExclusions(
        [
          { name: 'NOT_COUNTED', entries: NOT_COUNTED },
          { name: 'HOST_EDGES', entries: HOST_EDGES },
        ],
        (f) => sources.get(f),
        shared,
      ),
    )
    await Promise.all(
      PACKAGES.map(async (pkg) => {
        const parsed = [...sources]
          .filter(([f]) => f.startsWith(`${pkg}/src/`) && !excluded.has(f))
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
                `Write it as an Effect. A promise face kept for callers not yet moved is listed in effect-ratchet.faces.json, and is never paid for by raising this number. ` +
                `Adding a path to NOT_COUNTED or HOST_EDGES, or raising a count in either, is raising the baseline.`,
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
      problems.push(
        `not counted, listed as exclusions:\n${[...NOT_COUNTED, ...HOST_EDGES]
          .map((e) => `  ${e.path} async ${e.async} run ${e.run} (${e.reason})`)
          .join('\n')}`,
      )
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
