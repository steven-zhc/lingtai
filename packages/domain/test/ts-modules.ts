/** Reading TypeScript the way the ratchet and the import-graph tests do: through the AST, never a regex. */
import ts from 'typescript'

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
