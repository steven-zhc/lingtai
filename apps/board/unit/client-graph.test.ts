import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * No `"use client"` file may reach a server module (#933, #230).
 *
 * `apps/release/integration/build.test.ts` (the Next build) is the only thing
 * that really sees a server-only import inside a client graph, and it runs after
 * the merge. This is the unit-half stand-in: it reads source text and walks
 * **value** imports (`import type` is erased) from every `'use client'` file.
 * It can only claim that no static value-import path exists; a dynamic
 * `import()` with a computed specifier is beyond it.
 */
const here = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(here, '../src')
const DOMAIN = resolve(here, '../../../packages/domain/src')

const FORBIDDEN = (spec: string): string | null => {
  if (spec.startsWith('node:')) return 'a node: module'
  if (spec === '@lingtai/repo' || spec.startsWith('@lingtai/repo/')) return '@lingtai/repo'
  if (spec === '@lingtai/conductor' || spec.startsWith('@lingtai/conductor/')) return '@lingtai/conductor'
  if (spec === '@lingtai/setup' || spec.startsWith('@lingtai/setup/')) return '@lingtai/setup'
  // Its root pulls in `node:crypto`, which only the post-merge Next build would otherwise catch (#230, #1160).
  if (spec === '@lingtai/sandbox' || spec.startsWith('@lingtai/sandbox/')) return '@lingtai/sandbox'
  return null
}

const valueImports = (source: string): string[] => {
  const out: string[] = []
  const re =
    /(?:^|\n)\s*(import|export)\s+(type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g
  for (const m of source.matchAll(re)) {
    if (m[2] !== undefined) continue
    // `import { type A }` alone erases the whole import under verbatimModuleSyntax only when all are types.
    const clause = m[3] ?? ''
    if (m[1] === 'import' && /^\{[^}]*\}$/.test(clause.trim())) {
      const names = clause
        .trim()
        .slice(1, -1)
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean)
      if (names.length > 0 && names.every((n) => n.startsWith('type '))) continue
    }
    out.push((m[4] ?? m[5])!)
  }
  return out
}

function resolveFile(from: string, spec: string, srcRoot: string): string | null {
  const base = spec.startsWith('@/') ? join(srcRoot, spec.slice(2)) : resolve(dirname(from), spec)
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
  )

/** Every path from a client file to something forbidden, as `a -> b -> why`. */
export function violations(root: string): string[] {
  const found: string[] = []
  const clients = filesUnder(root).filter((f) => /^\s*['"]use client['"]/m.test(readFileSync(f, 'utf8')))
  for (const client of clients) {
    const seen = new Set<string>()
    const walk = (file: string, path: string[]) => {
      if (seen.has(file)) return
      seen.add(file)
      const text = readFileSync(file, 'utf8')
      // A `'use server'` module is compiled to RPC stubs in a client graph: its
      // own imports never ship, so the walk stops there.
      if (file !== client && /^\s*['"]use server['"]/m.test(text)) return
      for (const spec of valueImports(text)) {
        const bad = FORBIDDEN(spec)
        if (bad !== null) found.push([...path, file, `${spec} (${bad})`].join(' -> '))
        else if (spec.startsWith('.') || spec.startsWith('@/')) {
          const next = resolveFile(file, spec, root)
          if (next !== null) {
            if (next.endsWith('expand-prompts.ts')) found.push([...path, file, next].join(' -> '))
            else walk(next, [...path, file])
          }
        }
      }
    }
    walk(client, [])
  }
  return found
}

describe('the client graph (#933)', () => {
  it('has at least one client component, so the walk is not vacuous', () => {
    expect(filesUnder(SRC).some((f) => /['"]use client['"]/.test(readFileSync(f, 'utf8')))).toBe(true)
  })

  it('reaches no server module from any "use client" file', () => {
    expect(violations(SRC)).toEqual([])
  })

  it('fails on a client file that imports a module importing node:child_process', () => {
    const got = violations(join(here, 'fixtures/client-graph'))
    expect(got).toHaveLength(1)
    expect(got[0]).toContain('helper.ts')
    expect(got[0]).toContain('node:child_process')
  })

  it('holds @lingtai/domain, which client files import, to no node: import', () => {
    for (const f of filesUnder(DOMAIN)) {
      expect(
        valueImports(readFileSync(f, 'utf8')).filter((s) => s.startsWith('node:')),
        f,
      ).toEqual([])
    }
  })
})
