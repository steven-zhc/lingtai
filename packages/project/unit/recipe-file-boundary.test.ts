/**
 * No caller holds a recipe file port, and none reads or writes a recipe file (0128 §7, #1178).
 *
 * The module's reads are `recipeText`, `recipeValue` and `projectsOnDisk`, its writes `changeRecipe`, and its
 * port is `ProjectFiles`, provided by a test and never passed. This is a **tripwire over source text**, as
 * `packages/conductor/unit/recorded-recipe.test.ts`'s is, and not a proof: a dynamic `import('node:fs')` or a
 * path assembled across three variables gets past it, and a reviewer must not hold it to either.
 *
 * It reads the syntax tree and not the text, so **prose that names the file stays legal** — a message, a label, a
 * comment or a JSX string mentioning `recipe.yml` is not a read. What is refused, outside `packages/project/src`:
 *
 * 1. an import of the port — `ProjectFiles`, `diskFiles`, `filesEffect`, `readRecipeFile`, `replaceRecipeFile`
 *    from `@lingtai/project`, or `RecipeFiles` from `@lingtai/recipe`;
 * 2. a read or write call — `readFile`, `writeFile`, `existsSync`, `stat`, `rename`, … or a port's `.read` /
 *    `.replace` — whose first argument is a recipe path: `recipePath(…)`, a string holding `recipe.yml`, a
 *    `join`/`resolve` of one, or a `const` in the same file that is one (one hop, no further).
 *
 * **This test has been made to go red on purpose**: a `readFileSync(recipePath('x'))` added to a scratch copy of
 * `apps/cli/src/status.ts` failed it, naming that file and line, and was removed again.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

const PORT_NAMES = new Set([
  'ProjectFiles',
  'diskFiles',
  'filesEffect',
  'readRecipeFile',
  'replaceRecipeFile',
  'RecipeFiles',
])

/** Calls that read, write, probe or move a file, by the name they are called under. */
const FILE_CALLS = new Set([
  'readFile',
  'readFileSync',
  'writeFile',
  'writeFileSync',
  'existsSync',
  'stat',
  'statSync',
  'lstat',
  'lstatSync',
  'rename',
  'renameSync',
  'access',
  'accessSync',
  'copyFile',
  'copyFileSync',
  'link',
  'linkSync',
  'symlink',
  'symlinkSync',
  'unlink',
  'unlinkSync',
  'read',
  'replace',
])

/** Calls whose second argument is a path too. */
const TWO_PATHS = new Set([
  'rename',
  'renameSync',
  'copyFile',
  'copyFileSync',
  'link',
  'linkSync',
  'symlink',
  'symlinkSync',
])

const calleeName = (node: ts.CallExpression): string | undefined => {
  const e = node.expression
  if (ts.isIdentifier(e)) return e.text
  if (ts.isPropertyAccessExpression(e)) return e.name.text
  return undefined
}

const unwrap = (node: ts.Expression): ts.Expression => {
  let n = node
  while (
    ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isNonNullExpression(n) ||
    ts.isAwaitExpression(n)
  )
    n = n.expression
  return n
}

/**
 * What the nearest declaration of `id`'s name says it is: the initializer of a `const`, or `undefined` for a parameter,
 * a `let` or no declaration found — so a `path` that is a parameter is never mistaken for the `const path` of another
 * function in the same file.
 */
function constOf(id: ts.Identifier): ts.Expression | undefined {
  for (let a: ts.Node | undefined = id.parent; a !== undefined; a = a.parent) {
    if (ts.isFunctionLike(a))
      for (const param of a.parameters) if (ts.isIdentifier(param.name) && param.name.text === id.text) return undefined
    const statements =
      ts.isBlock(a) || ts.isSourceFile(a) || ts.isModuleBlock(a) || ts.isCaseClause(a) ? a.statements : undefined
    if (statements !== undefined)
      for (const st of statements)
        if (ts.isVariableStatement(st))
          for (const d of st.declarationList.declarations)
            if (ts.isIdentifier(d.name) && d.name.text === id.text)
              return (st.declarationList.flags & ts.NodeFlags.Const) !== 0 ? d.initializer : undefined
  }
  return undefined
}

/** Whether `node` is a path to a recipe file; an identifier is followed once, to its `const`. */
function isRecipePath(node: ts.Expression, follow: boolean, bare = true): boolean {
  const n = unwrap(node)
  // `bare` false: a string that merely contains the name is prose (`message.replace('recipe.yml', …)`), not a path.
  if (ts.isStringLiteralLike(n)) return bare && n.text.includes('recipe.yml')
  if (ts.isTemplateExpression(n))
    return (
      bare &&
      (n.head.text.includes('recipe.yml') ||
        n.templateSpans.some((s) => s.literal.text.includes('recipe.yml') || isRecipePath(s.expression, false)))
    )
  if (ts.isBinaryExpression(n)) return isRecipePath(n.left, follow, bare) || isRecipePath(n.right, follow, bare)
  if (ts.isCallExpression(n)) {
    const name = calleeName(n)
    if (name === 'recipePath') return true
    if (name === 'join' || name === 'resolve') return n.arguments.some((a) => isRecipePath(a, follow))
    return false
  }
  if (ts.isIdentifier(n) && follow) {
    const init = constOf(n)
    return init !== undefined && isRecipePath(init, false, bare)
  }
  return false
}

/** Every place `text` (the source of `file`) holds the port or reads or writes a recipe file, as `file:line: why`. */
export function recipeFileUses(file: string, text: string): string[] {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const found: string[] = []
  const namespaces = new Set<string>()
  const at = (node: ts.Node, why: string) =>
    found.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${why}`)

  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
      const from = (node.moduleSpecifier as ts.StringLiteral).text
      const named = ts.isImportDeclaration(node)
        ? node.importClause?.namedBindings
        : node.exportClause !== undefined && ts.isNamedExports(node.exportClause)
          ? node.exportClause
          : undefined
      if (
        ts.isImportDeclaration(node) &&
        node.importClause?.namedBindings !== undefined &&
        ts.isNamespaceImport(node.importClause.namedBindings) &&
        (from === '@lingtai/project' || from === '@lingtai/recipe')
      )
        namespaces.add(node.importClause.namedBindings.name.text)
      if (/(^|\/)project\/src\/files(\.ts)?$/.test(from)) at(node, `imports the module's file port from ${from}`)
      else if (named !== undefined && (from === '@lingtai/project' || from === '@lingtai/recipe'))
        if (ts.isNamedImports(named) || ts.isNamedExports(named))
          for (const el of named.elements) {
            const name = (el.propertyName ?? el.name).text
            const refused = from === '@lingtai/recipe' ? name === 'RecipeFiles' : PORT_NAMES.has(name)
            if (refused) at(el, `imports ${name} from ${from}`)
          }
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      namespaces.has(node.expression.text) &&
      (PORT_NAMES.has(node.name.text) || node.name.text === 'replaceFileFace' || node.name.text === 'readFileFace')
    )
      at(node, `uses ${node.expression.text}.${node.name.text}, the module's file port`)
    if (ts.isCallExpression(node)) {
      const name = calleeName(node)
      if (name !== undefined && FILE_CALLS.has(name)) {
        // A port's `.read`/`.replace` takes a path; a bare string there is `String.prototype.replace`'s search text.
        const bare = name !== 'read' && name !== 'replace'
        // A move or copy names two paths: the destination replaces a recipe as surely as a write does.
        const both = TWO_PATHS.has(name) ? node.arguments.slice(0, 2) : node.arguments.slice(0, 1)
        if (both.some((a) => isRecipePath(a, true, bare))) at(node, `${name}(…) on a recipe path`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

/** The `.ts` and `.tsx` source of every app and package, but the module's own. */
function sources(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.next') continue
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.tsx?$/.test(entry)) out.push(path)
    }
  }
  for (const group of ['apps', 'packages'])
    for (const unit of readdirSync(join(ROOT, group))) {
      const src = join(ROOT, group, unit, 'src')
      try {
        if (statSync(src).isDirectory()) walk(src)
      } catch {
        // a workspace with no `src`
      }
    }
  return out.filter((p) => !relative(ROOT, p).startsWith(join('packages', 'project', 'src') + '/'))
}

describe('no recipe file is read, written or held outside @lingtai/project (0128 §7)', () => {
  it('finds nothing in apps/*/src or packages/*/src', () => {
    const uses = sources().flatMap((p) => recipeFileUses(relative(ROOT, p), readFileSync(p, 'utf8')))
    expect(uses).toEqual([])
  })

  it('scans the tree it claims to (a path change must not empty it)', () => {
    const scanned = sources().map((p) => relative(ROOT, p))
    expect(scanned.length).toBeGreaterThan(200)
    expect(scanned).toContain('apps/cli/src/init.ts')
    expect(scanned).toContain('packages/conductor/src/add-from-page.ts')
    expect(scanned.some((p) => p.startsWith('packages/project/src'))).toBe(false)
  })
})

describe('the checker', () => {
  const found = (code: string, file = 'apps/x/src/a.ts') => recipeFileUses(file, code)

  it.each([
    ["readFileSync(recipePath('x'))", 'readFileSync(…) on a recipe path'],
    ["await readFile(recipePath('x', home), 'utf8')", 'readFile(…) on a recipe path'],
    ["writeFileSync(join(home, name, 'recipe.yml'), text)", 'writeFileSync(…) on a recipe path'],
    ["existsSync(join(home, name, 'recipe.yml'))", 'existsSync(…) on a recipe path'],
    ['const p = recipePath(name, home); await stat(p)', 'stat(…) on a recipe path'],
    ['const p = `${home}/${name}/recipe.yml`; rename(p, q)', 'rename(…) on a recipe path'],
    ['files.read(recipePath(name, home))', 'read(…) on a recipe path'],
    ["deps.files.replace(resolve(home, 'recipe.yml'), text)", 'replace(…) on a recipe path'],
    ['lift(() => world.files.read(recipePath(project, world.home)))', 'read(…) on a recipe path'],
    ["rename(tempPath, recipePath('x'))", 'rename(…) on a recipe path'],
    ["await copyFile(tempPath, join(home, 'x', 'recipe.yml'))", 'copyFile(…) on a recipe path'],
    ["renameSync(tmp, recipePath('x'))", 'renameSync(…) on a recipe path'],
  ])('catches %s', (code, why) => {
    const uses = found(code)
    expect(uses).toHaveLength(1)
    expect(uses[0]).toContain(why)
    expect(uses[0]).toMatch(/^apps\/x\/src\/a\.ts:1: /)
  })

  it.each([
    ["import { ProjectFiles } from '@lingtai/project'", 'ProjectFiles'],
    ["import { diskFiles, recipePath } from '@lingtai/project'", 'diskFiles'],
    ["import { filesEffect } from '@lingtai/project'", 'filesEffect'],
    ["import { readRecipeFile as r } from '@lingtai/project'", 'readRecipeFile'],
    ["import type { RecipeFiles } from '@lingtai/recipe'", 'RecipeFiles'],
    ["export { diskFiles } from '@lingtai/project'", 'diskFiles'],
    ["import { diskFiles } from '../../project/src/files.ts'", "module's file port"],
    ["import * as project from '@lingtai/project'\nconst port = yield* project.ProjectFiles", 'project.ProjectFiles'],
    ["import * as p from '@lingtai/project'\np.diskFiles.read(x)", 'p.diskFiles'],
  ])('catches %s', (code, why) => {
    const uses = found(code)
    expect(uses).toHaveLength(1)
    expect(uses[0]).toContain(why)
  })

  it('names the line of each use', () => {
    const uses = found("const a = 1\n\nreadFileSync(recipePath('x'))\n")
    expect(uses).toEqual(['apps/x/src/a.ts:3: readFileSync(…) on a recipe path'])
  })

  it.each([
    // prose that names the file: the four sites the ticket names, in the shapes they hold it
    ["const hint = 'edit recipe.yml by hand'"],
    ['const label = `reading ${project}/recipe.yml`'],
    ['// the recipe.yml is read by loadProject'],
    ['return <p>The file is recipe.yml</p>', 'apps/board/src/app/pending.tsx'],
    ['console.log(`${path}: recipe.yml has no steps`)'],
    // a path built and handed back, never read
    ["return join(home, project, 'recipe.yml')"],
    // reads and writes of other things
    ['readFileSync(configPath)'],
    ["const c = join(home, 'config.yml'); existsSync(c)"],
    ["'x'.replace(/a/, 'b')"],
    ["console.log(message.replace('recipe.yml', path))"],
    ['console.log(message.replace(`recipe.yml`, path))'],
    ["import * as project from '@lingtai/project'\nproject.recipeText(p)"],
    ['map.read(key)'],
    // what the module does export is legal to import and call
    ["import { recipeText, recipeValue, projectsOnDisk, recipePath, changeRecipe } from '@lingtai/project'"],
    ["import type { RecipeChange } from '@lingtai/recipe'"],
    ['recipeText(project, { home })'],
    ['const draft = yield* draftRecipe(project); draft.text()'],
  ])('lets %s through', (...row: [string] | [string, string]) => {
    expect(found(row[0], row[1])).toEqual([])
  })

  it('follows a const one hop and no further', () => {
    expect(found("const a = recipePath('x')\nreadFileSync(a)")).toHaveLength(1)
    expect(found("const a = recipePath('x')\nconst b = a\nreadFileSync(b)")).toEqual([])
  })
})
