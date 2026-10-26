/**
 * `doc/cli.json` and `doc/cli.md` against the definitions and the parser (#545).
 *
 * Beside the code rather than beside the site, for the reason
 * `packages/recipe/unit/plugin-pages.test.ts` gives: the committed document is
 * what the code is judged against. A red here means `pnpm docs:cli` was not run.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { cliManifest, renderCliPage, renderManifest } from '../src/cli-doc.ts'
import { COMMANDS } from '../src/commands.ts'

const doc = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../doc/${name}`, import.meta.url)), 'utf8')
const stale = (name: string): string => `doc/${name} is stale — run \`pnpm docs:cli\` and commit it`

describe('the generated CLI guide', () => {
  const manifest = cliManifest()
  const flagsOf = (name: string): readonly string[] => manifest.commands.find((c) => c.name === name)?.flags ?? []

  it('commits the manifest it would write', () => {
    expect(doc('cli.json'), stale('cli.json')).toBe(renderManifest(manifest))
  })

  it('commits the page it would write, rendered from the manifest alone', () => {
    expect(doc('cli.md'), stale('cli.md')).toBe(renderCliPage(JSON.parse(doc('cli.json'))))
  })

  it('carries every command once', () => {
    expect(manifest.commands.map((c) => c.name).sort()).toEqual(COMMANDS.map((c) => c.name).sort())
  })

  it("reads a verb's flags out of the parser tree, and no argument as a flag", () => {
    expect(flagsOf('backlog')).toEqual(expect.arrayContaining(['--kind', '--reason', '--json']))
    expect(flagsOf('ticket')).toContain('--project')
    for (const c of manifest.commands) expect(c.flags.every((f) => /^--[a-z][a-z-]*$/.test(f))).toBe(true)
  })

  it('names a --json version exactly where the parser takes --json', () => {
    for (const c of manifest.commands) expect(c.json !== null).toBe(c.flags.includes('--json'))
  })

  it('promises --json on a verdict only where every invocation shows it', () => {
    const page = renderCliPage(manifest)
    const section = (name: string): string => page.split(`### lingtai ${name}\n`)[1]!.split('\n### ')[0]!
    expect(section('env')).not.toContain('on its verdict')
    expect(section('env')).toContain('only on the invocations that show it')
    expect(section('approve')).toContain('on its verdict')
  })

  it('has no flag in its usage prose that the parser does not take', () => {
    for (const c of manifest.commands) {
      // a line that runs another tool (`pnpm --filter …`) names that tool's flags, not ours
      const ours = c.usage.filter((line) => !/^\s*pnpm /.test(line))
      const named = new Set(ours.join('\n').match(/--[a-z][a-z-]*/g) ?? [])
      named.delete('--help')
      expect(
        [...named].filter((f) => !c.flags.includes(f)),
        c.name,
      ).toEqual([])
    }
  })
})
