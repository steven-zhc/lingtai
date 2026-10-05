/**
 * `../test/postgres.ts`'s `ON_POSTGRES` is a list kept in prose about which
 * integration files still need a real Postgres, and a list kept in prose
 * drifts (0055 §1). This is the type that decides instead: it reads every
 * integration file's own imports and fails if one reaches Postgres by name
 * without being listed, or if a listed one no longer does.
 *
 * **This is the unit-level stand-in for `pnpm test:integration`.** That run is
 * 803s against a 600s ceiling (CLAUDE.md), so no gate can assert "the
 * integration half passes with no LINGTAI_TEST_DATABASE_URL set". What `pnpm
 * test` can assert is that no file reaches Postgres without a name on this
 * list and a reason beside it — the skip itself, and whether it still applies,
 * is only known once something runs the suite against a real database (#275).
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

import { repoRoot } from '@lingtai/env'
import { describe, expect, it } from 'vitest'

import { ON_POSTGRES } from '../test/postgres.ts'

/** Every integration test file, repo-relative. */
function integrationFiles(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = []
  for (const area of ['packages', 'apps']) {
    let packages
    try {
      packages = readdirSync(join(repoRoot(), area), { withFileTypes: true })
    } catch {
      continue
    }
    for (const pkg of packages) {
      if (!pkg.isDirectory()) continue
      const dir = join(repoRoot(), area, pkg.name, 'integration')
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.test.ts')) continue
        const path = join(dir, entry.name)
        out.push({ file: relative(repoRoot(), path), text: readFileSync(path, 'utf8') })
      }
    }
  }
  return out
}

/**
 * `from "pg"`, `createDb(`, `createPostgres…(` — the ticket's own grep, made a
 * type.
 *
 * **Code only, never prose.** Half the files this reads explain, in a comment,
 * what they used to do or what a sibling file does — `the-written-choice.test.ts`
 * says `createDb(postgresUrl())` in a sentence about `choose.ts`'s history
 * without calling either. Matching the comment would demand a reason from a
 * file that reaches no database at all.
 *
 * No no-argument `(direct)postgresUrl()` clause, on purpose: resolving a
 * connection *string* is not opening a connection, and `packages/daemon/
 * integration/the-written-choice.test.ts` proves it — its "postgres" cases hand
 * a fabricated URL to a `net.Socket.prototype.connect` stub that never lets a
 * socket open. What actually reaches a server is `pg`'s own client, `createDb`,
 * or a `createPostgres…` factory, and those are what this checks.
 */
const REACHES_POSTGRES = /from ["']pg["']|\bcreateDb\(|\bcreatePostgres[A-Za-z]*\(/

/** Strips comments, so prose about Postgres is never mistaken for code that reaches it. */
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('which integration files still need Postgres', () => {
  it('finds files to check', () => {
    expect(integrationFiles().length).toBeGreaterThan(20)
  })

  it('lists every file that reaches Postgres, and no file that does not', () => {
    const files = integrationFiles()
    const seen = new Set(files.map((f) => f.file))

    const unlisted = files
      .filter((f) => REACHES_POSTGRES.test(code(f.text)) && !(f.file in ON_POSTGRES))
      .map((f) => f.file)
    expect(unlisted, `reach Postgres but are not in ON_POSTGRES:\n  ${unlisted.join('\n  ')}`).toEqual([])

    const stale = Object.keys(ON_POSTGRES).filter((file) => {
      const found = files.find((f) => f.file === file)
      return found === undefined || !REACHES_POSTGRES.test(code(found.text))
    })
    expect(stale, `listed in ON_POSTGRES but no longer reach Postgres:\n  ${stale.join('\n  ')}`).toEqual([])

    for (const file of Object.keys(ON_POSTGRES)) expect(seen).toContain(file)
  })

  it('gives every listed file a reason', () => {
    for (const [file, reason] of Object.entries(ON_POSTGRES)) {
      expect(reason.length, `${file} has no reason`).toBeGreaterThan(0)
    }
  })
})
