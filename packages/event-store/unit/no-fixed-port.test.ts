/**
 * 0122 §6 says a test that binds a fixed port is a defect at N > 1, and until
 * this file that was prose. Most of the tests that bind a port are
 * integration, which no pass can run (803s against a 600s ceiling), so this
 * is the unit-level stand-in: it reads every test file as text and fails on a
 * `.listen(` whose first argument is a nonzero number, or a constant bound to
 * one. `listen(0, …)` and a port handed in by `freePort()` are the allowed
 * forms.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

import { repoRoot } from '@lingtai/env'
import { describe, expect, it } from 'vitest'

/** Every test file under `{apps,packages}/*\/{unit,integration}`, recursively. */
function testFiles(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = []
  const walk = (dir: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.test\.tsx?$/.test(entry.name))
        out.push({ file: relative(repoRoot(), path), text: readFileSync(path, 'utf8') })
    }
  }
  for (const area of ['apps', 'packages']) {
    let pkgs
    try {
      pkgs = readdirSync(join(repoRoot(), area), { withFileTypes: true })
    } catch {
      continue
    }
    for (const pkg of pkgs) {
      if (!pkg.isDirectory()) continue
      for (const half of ['unit', 'integration']) walk(join(repoRoot(), area, pkg.name, half))
    }
  }
  return out
}

/** `.listen(` calls in `text` whose first argument is a fixed, nonzero port. */
export function fixedPorts(text: string): string[] {
  const constants = new Set<string>()
  for (const m of text.matchAll(
    /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::\s*number\s*)?=\s*([1-9]\d*)\s*(?:[;\n]|$)/g,
  )) {
    constants.add(m[1]!)
  }
  // Blank comments and strings in place, keeping every offset and newline, so a
  // call is matched across lines and a quoted or commented one is not a call.
  const code = text.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|`[^`]*`|'[^'\n]*'|"[^"\n]*"/g, (m) => m.replace(/[^\n]/g, ' '))
  const out: string[] = []
  for (const m of code.matchAll(/\.listen\(\s*([A-Za-z_$][\w$]*|\d+)/g)) {
    const arg = m[1]!
    if (!(/^\d+$/.test(arg) ? Number(arg) !== 0 : constants.has(arg))) continue
    const start = text.lastIndexOf('\n', m.index) + 1
    out.push(text.slice(start, text.indexOf('\n', m.index) + 1 || undefined).trim())
  }
  return out
}

describe('no test binds a fixed port (0122 §6)', () => {
  it('reads the test files it claims to', () => {
    expect(testFiles().length).toBeGreaterThan(100)
  })

  it('finds a literal, a constant bound to one, and leaves port 0 and a variable alone', () => {
    expect(fixedPorts('server.listen(17821)')).toEqual(['server.listen(17821)'])
    expect(fixedPorts('const PORT = 8080\nserver.listen(PORT, "127.0.0.1")')).toEqual([
      'server.listen(PORT, "127.0.0.1")',
    ])
    expect(fixedPorts('server.listen(0, "127.0.0.1", cb)')).toEqual([])
    expect(fixedPorts('const port = await freePort()\nserver.listen(port)')).toEqual([])
    expect(fixedPorts('// server.listen(8080)')).toEqual([])
    expect(fixedPorts("const a = 'server.listen(8080)'")).toEqual([])
    expect(fixedPorts('server.listen(\n  8080,\n  "127.0.0.1",\n)')).toHaveLength(1)
    expect(fixedPorts('const PORT = 8080\nserver\n  .listen(\n    PORT,\n  )')).toHaveLength(1)
    expect(fixedPorts('server.listen(\n  0,\n)')).toEqual([])
  })

  it('holds for every test file', () => {
    const found = testFiles().flatMap(({ file, text }) => fixedPorts(text).map((line) => `${file}: ${line}`))
    expect(found).toEqual([])
  })
})
