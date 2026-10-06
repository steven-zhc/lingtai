/**
 * `detectSetup` (#397): a pure read of a `SetupReader`, never asked of
 * anybody and never run.
 */
import { describe, expect, it } from 'vitest'

import { detectSetup, type SetupReader } from '../src/detect-setup.ts'

function reader(files: Record<string, string>, opts: { haveNotRead?: string[] } = {}): SetupReader {
  const haveNotRead = new Set(opts.haveNotRead ?? [])
  return {
    has: async (path) => path in files || haveNotRead.has(path),
    read: async (path) => (haveNotRead.has(path) ? null : (files[path] ?? null)),
  }
}

function pkg(scripts: Record<string, string>): string {
  return JSON.stringify({ scripts })
}

describe('detectSetup', () => {
  it('each lockfile gives its own install command', async () => {
    expect((await detectSetup(reader({ 'pnpm-lock.yaml': '' }))).install).toEqual({
      run: 'pnpm install --frozen-lockfile',
      because: 'pnpm-lock.yaml is at the root',
    })
    expect((await detectSetup(reader({ 'yarn.lock': '' }))).install).toEqual({
      run: 'yarn install --frozen-lockfile',
      because: 'yarn.lock is at the root',
    })
    expect((await detectSetup(reader({ 'package-lock.json': '' }))).install).toEqual({
      run: 'npm ci',
      because: 'package-lock.json is at the root',
    })
  })

  it('takes the first lockfile in the table and notes the others', async () => {
    const result = await detectSetup(reader({ 'pnpm-lock.yaml': '', 'package-lock.json': '' }))
    expect(result.install).toEqual({ run: 'pnpm install --frozen-lockfile', because: 'pnpm-lock.yaml is at the root' })
    expect(result.notes.some((n) => n.includes('package-lock.json'))).toBe(true)
  })

  it('no lockfile gives a null install and a note', async () => {
    const result = await detectSetup(reader({}))
    expect(result.install).toBeNull()
    expect(result.notes).toContain('no lockfile at the root')
  })

  it('finds all four scripts, in format, lint, typecheck, test order, spelled for the manager', async () => {
    const result = await detectSetup(
      reader({
        'pnpm-lock.yaml': '',
        'package.json': pkg({
          'fmt:check': 'oxfmt --check .',
          lint: 'oxlint',
          typecheck: 'tsc --noEmit',
          test: 'vitest run',
        }),
      }),
    )
    expect(result.build.map((b) => b.name)).toEqual(['format', 'lint', 'typecheck', 'test'])
    expect(result.build.map((b) => b.run)).toEqual(['pnpm fmt:check', 'pnpm lint', 'pnpm typecheck', 'pnpm test'])
  })

  it('spells the command for yarn and for npm (no lockfile)', async () => {
    const yarn = await detectSetup(reader({ 'yarn.lock': '', 'package.json': pkg({ lint: 'eslint .' }) }))
    expect(yarn.build[0]!.run).toBe('yarn lint')

    const npm = await detectSetup(reader({ 'package.json': pkg({ lint: 'eslint .' }) }))
    expect(npm.build[0]!.run).toBe('npm run lint')
  })

  it('falls back to format:check when there is no fmt:check, and only names it "format"', async () => {
    const result = await detectSetup(reader({ 'package.json': pkg({ 'format:check': 'prettier --check .' }) }))
    expect(result.build).toEqual([
      { name: 'format', run: 'npm run format:check', because: '`format:check` runs `prettier --check .`' },
    ])
  })

  it('prefers fmt:check over format:check when both are present', async () => {
    const result = await detectSetup(reader({ 'package.json': pkg({ 'fmt:check': 'a', 'format:check': 'b' }) }))
    expect(result.build).toEqual([{ name: 'format', run: 'npm run fmt:check', because: '`fmt:check` runs `a`' }])
  })

  it('no package.json gives an empty build and a note', async () => {
    const result = await detectSetup(reader({ 'pnpm-lock.yaml': '' }))
    expect(result.build).toEqual([])
    expect(result.notes).toContain('no package.json at the root')
  })

  it('a package.json that does not parse gives an empty build and a note', async () => {
    const result = await detectSetup(reader({ 'package.json': '{not json' }))
    expect(result.build).toEqual([])
    expect(result.notes).toContain('package.json does not parse')
  })

  it('skips an integration or e2e script by name, and never suggests it', async () => {
    const result = await detectSetup(
      reader({
        'package.json': pkg({ 'test:integration': 'vitest run --project integration', 'test:e2e': 'playwright test' }),
      }),
    )
    expect(result.build).toEqual([])
    expect(result.skipped.map((s) => s.script).sort()).toEqual(['test:e2e', 'test:integration'])
  })

  it('skips a candidate whose command runs a browser, even though its name does not say so', async () => {
    const result = await detectSetup(reader({ 'package.json': pkg({ test: 'playwright test' }) }))
    expect(result.build).toEqual([])
    expect(result.skipped).toEqual([{ script: 'test', why: expect.stringContaining('playwright test') }])
  })

  it('this repository’s own scripts: pnpm fmt:check/lint/typecheck/test, with test:integration and test:db skipped', async () => {
    const result = await detectSetup(
      reader({
        'pnpm-lock.yaml': '',
        'package.json': pkg({
          'fmt:check': "oxfmt --check 'packages/**/*.ts'",
          lint: 'oxlint --deny-warnings',
          test: 'vitest run --project unit',
          'test:integration': 'vitest run --project integration',
          'test:db': 'pnpm test:integration',
          'test:all': 'vitest run',
          typecheck: 'pnpm -r --if-present typecheck',
        }),
      }),
    )
    expect(result.build.map((b) => b.run)).toEqual(['pnpm fmt:check', 'pnpm lint', 'pnpm typecheck', 'pnpm test'])
    expect(result.skipped.map((s) => s.script).sort()).toEqual(['test:db', 'test:integration'])
  })

  it('a `has` that is true while `read` is null still detects the lockfile (the large-lockfile case)', async () => {
    const result = await detectSetup(reader({}, { haveNotRead: ['pnpm-lock.yaml'] }))
    expect(result.install).toEqual({ run: 'pnpm install --frozen-lockfile', because: 'pnpm-lock.yaml is at the root' })
  })
})
