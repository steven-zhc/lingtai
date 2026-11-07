/**
 * `detectSetup` (#397): a pure read of a `SetupReader`, never asked of
 * anybody and never run.
 */
import { describe, expect, it } from 'vitest'

import { DETECTORS, detectSetup, type SetupReader, type StackDetector } from '../src/detect-setup.ts'

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

  it('takes check as the typecheck when there is none, and build last', async () => {
    const result = await detectSetup(
      reader({
        'package-lock.json': '',
        'package.json': pkg({ check: 'astro check', build: 'astro build', test: 'vitest run' }),
      }),
    )
    expect(result.build).toEqual([
      { name: 'typecheck', run: 'npm run check', because: '`check` runs `astro check`' },
      { name: 'test', run: 'npm run test', because: '`test` runs `vitest run`' },
      { name: 'build', run: 'npm run build', because: '`build` runs `astro build`' },
    ])
  })

  it('proposes typecheck once, from typecheck, when check exists too', async () => {
    const result = await detectSetup(
      reader({ 'package.json': pkg({ typecheck: 'tsc --noEmit', check: 'astro check' }) }),
    )
    expect(result.build).toEqual([
      { name: 'typecheck', run: 'npm run typecheck', because: '`typecheck` runs `tsc --noEmit`' },
    ])
  })

  it('spells check as yarn run check, since yarn check is a built-in', async () => {
    const result = await detectSetup(
      reader({ 'yarn.lock': '', 'package.json': pkg({ check: 'astro check', build: 'astro build' }) }),
    )
    expect(result.build.map((b) => b.run)).toEqual(['yarn run check', 'yarn build'])
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

  describe('more than one stack at the root', () => {
    const stub: StackDetector = {
      stack: 'Stub',
      detect: async () => ({
        presence: 'present',
        install: { run: 'stub install', because: 'stub.lock is at the root' },
        build: [{ name: 'test', run: 'stub test', because: 'stub' }],
        skipped: [{ script: 'stub-e2e', why: 'stub' }],
        notes: ['a stub note'],
      }),
    }
    const files = { 'pnpm-lock.yaml': '', 'package.json': pkg({ lint: 'eslint .' }) }

    it('the first in the order supplies the commands and the other is named in a note', async () => {
      const result = await detectSetup(reader(files), [...DETECTORS, stub])
      expect(result.install?.run).toBe('pnpm install --frozen-lockfile')
      expect(result.build.map((b) => b.run)).toEqual(['pnpm lint'])
      expect(result.skipped).toEqual([])
      expect(result.notes.at(-1)).toBe('Stub is also at the root; Node was used')
    })

    it('the order decides, not Node', async () => {
      const result = await detectSetup(reader(files), [stub, ...DETECTORS])
      expect(result.install?.run).toBe('stub install')
      expect(result.build.map((b) => b.run)).toEqual(['stub test'])
      expect(result.notes).toEqual(['a stub note', 'Node is also at the root; Stub was used'])
    })
  })
})

describe('the Python detector', () => {
  const RUFF = '[tool.ruff]\nline-length = 100\n'
  const ALL = `${RUFF}\n[tool.mypy]\nstrict = true\n\n[tool.pytest.ini_options]\naddopts = "-q"\n`

  it('uv.lock gives uv sync and a uv run prefix on every build command', async () => {
    const result = await detectSetup(reader({ 'uv.lock': '', 'pyproject.toml': ALL }))
    expect(result.install).toEqual({ run: 'uv sync --frozen', because: 'uv.lock is at the root' })
    expect(result.build.map((b) => [b.name, b.run])).toEqual([
      ['format', 'uv run ruff format --check .'],
      ['lint', 'uv run ruff check --no-fix .'],
      ['typecheck', 'uv run mypy .'],
      ['test', 'uv run pytest'],
    ])
  })

  it('poetry.lock gives poetry install and a poetry run prefix on every build command', async () => {
    const result = await detectSetup(reader({ 'poetry.lock': '', 'pyproject.toml': ALL }))
    expect(result.install).toEqual({ run: 'poetry install --no-interaction', because: 'poetry.lock is at the root' })
    expect(result.build.map((b) => b.run)).toEqual([
      'poetry run ruff format --check .',
      'poetry run ruff check --no-fix .',
      'poetry run mypy .',
      'poetry run pytest',
    ])
  })

  it('both lockfiles: uv.lock wins and a note names poetry.lock', async () => {
    const result = await detectSetup(reader({ 'uv.lock': '', 'poetry.lock': '' }))
    expect(result.install?.run).toBe('uv sync --frozen')
    expect(result.notes).toContain('poetry.lock is also at the root; uv.lock was used')
  })

  it('only [tool.pytest.ini_options] gives pytest and no ruff or mypy', async () => {
    const result = await detectSetup(
      reader({ 'uv.lock': '', 'pyproject.toml': '[tool.pytest.ini_options]\nminversion = "7"\n' }),
    )
    expect(result.build.map((b) => b.run)).toEqual(['uv run pytest'])
  })

  it('[tool.ruff.lint] alone counts as ruff', async () => {
    const result = await detectSetup(reader({ 'uv.lock': '', 'pyproject.toml': '[tool.ruff.lint]\nselect = ["E"]\n' }))
    expect(result.build.map((b) => b.name)).toEqual(['format', 'lint'])
  })

  it('standalone files and a tests/ directory count; nothing else does', async () => {
    const result = await detectSetup(reader({ 'poetry.lock': '', 'ruff.toml': '', 'mypy.ini': '[mypy]\n', tests: '' }))
    expect(result.build.map((b) => [b.name, b.because])).toEqual([
      ['format', 'ruff.toml is at the root'],
      ['lint', 'ruff.toml is at the root'],
      ['typecheck', 'mypy.ini is at the root'],
      ['test', 'tests/ is at the root'],
    ])
    expect((await detectSetup(reader({ 'uv.lock': '', 'pyproject.toml': '[project]\nname = "x"\n' }))).build).toEqual(
      [],
    )
  })

  it('requirements.txt only gives no install, no build, and a note', async () => {
    const result = await detectSetup(
      reader({ 'requirements.txt': '', 'pyproject.toml': '[tool.pytest.ini_options]\nx = 1\n' }),
    )
    expect(result.install).toBeNull()
    expect(result.build).toEqual([])
    expect(result.notes.join('\n')).toMatch(/create a virtual environment and type the install command/)
    expect(result.notes.join('\n')).toMatch(/only through uv or poetry/)
  })

  it('a pyproject.toml that does not parse gives a note and nothing from it', async () => {
    const result = await detectSetup(reader({ 'uv.lock': '', 'pyproject.toml': '[tool.ruff\n' }))
    expect(result.install?.run).toBe('uv sync --frozen')
    expect(result.build).toEqual([])
    expect(result.notes).toContain('pyproject.toml does not parse')
  })

  it('a pyproject.toml that cannot be read gives a note, and tests/ still counts', async () => {
    const result = await detectSetup(reader({ 'uv.lock': '', tests: '' }, { haveNotRead: ['pyproject.toml'] }))
    expect(result.notes).toContain('pyproject.toml could not be read')
    expect(result.build.map((b) => b.name)).toEqual(['test'])
  })

  it('a `has` that rejects for a configuration file is "could not tell", not absent', async () => {
    const base = reader({ 'uv.lock': '', 'pyproject.toml': RUFF })
    const result = await detectSetup({
      ...base,
      has: async (path) => {
        if (path === 'mypy.ini') throw new Error('network')
        return base.has(path)
      },
    })
    expect(result.notes).toContain('could not tell whether mypy.ini is at the root')
    expect(result.build.map((b) => b.name)).toEqual(['format', 'lint'])
  })

  it('mypy takes no path where the config mypy reads names files', async () => {
    const typecheck = async (files: Record<string, string>) =>
      (await detectSetup(reader({ 'uv.lock': '', ...files }))).build.find((b) => b.name === 'typecheck')
    const set = await typecheck({ 'pyproject.toml': '[tool.mypy]\nfiles = ["src"]\n' })
    expect(set?.run).toBe('uv run mypy')
    expect(set?.because).toContain('files')
    for (const body of ['strict = true', 'files = []', 'files = ""']) {
      expect((await typecheck({ 'pyproject.toml': `[tool.mypy]\n${body}\n` }))?.run).toBe('uv run mypy .')
    }
    expect((await typecheck({ 'mypy.ini': '[mypy]\nfiles = src\n' }))?.run).toBe('uv run mypy')
    expect((await typecheck({ 'mypy.ini': '[mypy]\nfiles =\n  src\n  tests\n' }))?.run).toBe('uv run mypy')
    const both = { 'pyproject.toml': '[tool.mypy]\nfiles = ["src"]\n' }
    expect((await typecheck({ ...both, 'mypy.ini': '[mypy]\nstrict = true\n' }))?.run).toBe('uv run mypy .')
    expect((await typecheck({ ...both, 'mypy.ini': '[other]\na = b\n' }))?.run).toBe('uv run mypy')
  })

  it('a mypy.ini that cannot be read or parsed is never taken as "no files"', async () => {
    const files = { 'uv.lock': '', 'pyproject.toml': '[tool.mypy]\nfiles = ["src"]\n' }
    const broken = await detectSetup(reader({ ...files, 'mypy.ini': 'strict = true\n' }))
    expect(broken.build.find((b) => b.name === 'typecheck')).toBeUndefined()
    expect(broken.notes).toContain('mypy.ini does not parse')
    const base = reader(files)
    const unknown = await detectSetup({
      ...base,
      has: async (path) => {
        if (path === 'mypy.ini') throw new Error('network')
        return base.has(path)
      },
    })
    expect(unknown.build.find((b) => b.name === 'typecheck')).toBeUndefined()
    expect(unknown.notes).toContain('could not tell whether mypy.ini is at the root')
  })

  it('a lockfile `has` that rejects is "could not tell", not "no lockfile"', async () => {
    const base = reader({ 'requirements.txt': '' })
    const result = await detectSetup({
      ...base,
      has: async (path) => {
        if (path === 'uv.lock') throw new Error('network')
        return base.has(path)
      },
    })
    expect(result.install).toBeNull()
    expect(result.notes).toContain('could not tell whether uv.lock is at the root')
    expect(result.notes.join('\n')).not.toMatch(/no uv\.lock or poetry\.lock/)
  })

  it('a ruff.toml that does not parse gives a note and no ruff commands', async () => {
    const result = await detectSetup(reader({ 'uv.lock': '', 'ruff.toml': '[invalid' }))
    expect(result.build).toEqual([])
    expect(result.notes).toContain('ruff.toml does not parse')
  })

  it('a pytest.ini that does not parse gives a note and no pytest command', async () => {
    const result = await detectSetup(reader({ 'uv.lock': '', 'pytest.ini': '[pytest\n' }))
    expect(result.build).toEqual([])
    expect(result.notes).toContain('pytest.ini does not parse')
  })

  it('an ini file with an indented malformed header or no section header does not parse', async () => {
    const indented = await detectSetup(reader({ 'uv.lock': '', 'mypy.ini': '  [mypy\n' }))
    expect(indented.build).toEqual([])
    expect(indented.notes).toContain('mypy.ini does not parse')
    const bare = await detectSetup(reader({ 'uv.lock': '', 'mypy.ini': 'strict = true\n' }))
    expect(bare.build).toEqual([])
    expect(bare.notes).toContain('mypy.ini does not parse')
    const header = await detectSetup(reader({ 'uv.lock': '', 'mypy.ini': '  [mypy]\n  strict = true\n' }))
    expect(header.build.map((b) => b.name)).toEqual(['typecheck'])
    const key = await detectSetup(reader({ 'uv.lock': '', 'pytest.ini': '[pytest]\n  addopts = -q\n' }))
    expect(key.build.map((b) => b.name)).toEqual(['test'])
    const ok = await detectSetup(reader({ 'uv.lock': '', 'mypy.ini': '[mypy]\nplugins =\n  a\n  b\n' }))
    expect(ok.build.map((b) => b.name)).toEqual(['typecheck'])
  })

  it('Node and Python in one root: Node wins and Python is named in a note', async () => {
    const result = await detectSetup(
      reader({ 'pnpm-lock.yaml': '', 'package.json': pkg({ lint: 'eslint .' }), 'uv.lock': '' }),
    )
    expect(result.install?.run).toBe('pnpm install --frozen-lockfile')
    expect(result.build.map((b) => b.run)).toEqual(['pnpm lint'])
    expect(result.notes).toContain('Python is also at the root; Node was used')
  })
})

describe('the Go detector', () => {
  const GO = { 'go.mod': 'module x\n' }
  const run = (r: ReturnType<typeof detectSetup>) => r.then((x) => x.build.map((b) => b.run))

  it('go.mod alone gives the install and three build commands, the format check failing on output', async () => {
    const result = await detectSetup(reader(GO))
    expect(result.install).toEqual({ run: 'go mod download', because: 'go.mod is at the root' })
    expect(result.build.map((b) => b.run)).toEqual([
      'out=$(gofmt -l .) && test -z "$out"',
      'go vet ./...',
      'go test ./...',
    ])
    expect(result.build[0]?.tool).toBe('gofmt')
  })

  it.each(['.golangci.yml', '.golangci.yaml', '.golangci.toml'])('%s adds golangci-lint run', async (file) => {
    const text = file.endsWith('.toml') ? 'a = 1\n' : 'linters:\n  enable: [govet]\n'
    const result = await detectSetup(reader({ ...GO, [file]: text }))
    expect(result.build.map((b) => b.run)).toEqual([
      'out=$(gofmt -l .) && test -z "$out"',
      'go vet ./...',
      'golangci-lint run',
      'go test ./...',
    ])
    expect(result.build[2]?.because).toBe(`${file} is at the root`)
  })

  it('two configs: the first is used and a note names the second', async () => {
    const result = await detectSetup(reader({ ...GO, '.golangci.yml': 'a: 1\n', '.golangci.toml': 'a = 1\n' }))
    expect(result.build.map((b) => b.name)).toContain('lint')
    expect(result.notes).toContain('.golangci.toml is also at the root; .golangci.yml was used')
  })

  it('a config that does not parse gets a note and no lint', async () => {
    const result = await detectSetup(reader({ ...GO, '.golangci.yml': 'a: [1\n' }))
    expect(result.notes).toContain('.golangci.yml does not parse')
    expect(result.build.map((b) => b.name)).not.toContain('lint')
  })

  it('a rejected lookup of an earlier config withholds lint rather than falling to a later file', async () => {
    const files: Record<string, string> = { ...GO, '.golangci.yaml': 'a: 1\n' }
    const result = await detectSetup({
      has: async (p) => {
        if (p === '.golangci.yml') throw new Error('no')
        return p in files
      },
      read: async (p) => files[p] ?? null,
    })
    expect(result.build.map((b) => b.name)).not.toContain('lint')
    expect(result.notes).toContain('could not tell whether .golangci.yml is at the root')
  })

  it('has(go.mod) rejecting is could-not-tell', async () => {
    const result = await detectSetup({
      has: async () => {
        throw new Error('no')
      },
      read: async () => null,
    })
    expect(result.install).toBeNull()
    expect(result.notes).toContain('could not tell whether a Go module is at the root')
  })

  it('vendor/ keeps the install and adds a note', async () => {
    const result = await detectSetup(reader({ ...GO, vendor: '' }))
    expect(result.install?.run).toBe('go mod download')
    expect(result.notes.some((n) => n.startsWith('vendor/ is at the root'))).toBe(true)
    expect(await run(Promise.resolve(result))).toHaveLength(3)
  })

  it('package.json plus go.mod: Node is used and a note names Go', async () => {
    const result = await detectSetup(reader({ ...GO, 'package.json': pkg({ test: 'x' }), 'package-lock.json': '' }))
    expect(result.install?.run).not.toBe('go mod download')
    expect(result.notes).toContain(`Go is also at the root; Node was used`)
  })
})

describe('detectSetup — Java', () => {
  const POM = '<?xml version="1.0"?><project><modelVersion>4.0.0</modelVersion><!-- <x> --></project>'
  const GRADLE = 'plugins { id \'java\' }\n// }\ndependencies { implementation("a:b:1") }\n'
  const rejecting = (bad: string, files: Record<string, string>): SetupReader => ({
    has: async (path) => {
      if (path === bad) throw new Error('no')
      return path in files
    },
    read: async (path) => files[path] ?? null,
  })
  const commands = (r: Awaited<ReturnType<typeof detectSetup>>) => [r.install?.run ?? '', ...r.build.map((b) => b.run)]

  it('Maven without a wrapper', async () => {
    const r = await detectSetup(reader({ 'pom.xml': POM }))
    expect(r.install).toEqual({ run: 'mvn -B -q dependency:go-offline', because: 'pom.xml is at the root' })
    expect(r.build.map((b) => b.run)).toEqual(['mvn -B test'])
    expect(r.build[0]!.tool).toBeUndefined()
  })

  it('Maven with mvnw uses it and probes java', async () => {
    const r = await detectSetup(reader({ 'pom.xml': POM, mvnw: '' }))
    expect(r.install?.run).toBe('./mvnw -B -q dependency:go-offline')
    expect(r.install?.tool).toBe('java')
    expect(r.build[0]).toMatchObject({ run: './mvnw -B test', tool: 'java' })
  })

  it.each(['build.gradle', 'build.gradle.kts'])('Gradle from %s, no separate install', async (file) => {
    const r = await detectSetup(reader({ [file]: GRADLE }))
    expect(r.install).toBeNull()
    expect(r.build.map((b) => b.run)).toEqual(['gradle test'])
    expect(r.build[0]!.because).toBe(`${file} is at the root`)
    expect(r.notes.some((n) => n.startsWith('Gradle has no separate install'))).toBe(true)
  })

  it('Gradle with gradlew uses it', async () => {
    const r = await detectSetup(reader({ 'build.gradle.kts': GRADLE, gradlew: '' }))
    expect(r.build[0]).toMatchObject({ run: './gradlew test', tool: 'java' })
  })

  it('pom.xml plus build.gradle: Gradle wins and a note names pom.xml', async () => {
    const r = await detectSetup(reader({ 'pom.xml': POM, 'build.gradle': GRADLE }))
    expect(r.build[0]!.run).toBe('gradle test')
    expect(r.notes).toContain('pom.xml is also at the root; build.gradle was used')
  })

  it('never suggests verify or check', async () => {
    const cases: Record<string, string>[] = [
      { 'pom.xml': POM },
      { 'pom.xml': POM, mvnw: '' },
      { 'build.gradle': GRADLE },
      { 'build.gradle': GRADLE, gradlew: '' },
    ]
    for (const files of cases) {
      for (const c of commands(await detectSetup(reader(files)))) expect(c).not.toMatch(/\b(verify|check)\b/)
    }
  })

  it('names the 15m default timeout', async () => {
    const r = await detectSetup(reader({ 'pom.xml': POM }))
    expect(r.notes.some((n) => n.includes('15m'))).toBe(true)
  })

  it('has(build.gradle) rejecting beside pom.xml suggests nothing', async () => {
    const r = await detectSetup(rejecting('build.gradle', { 'pom.xml': POM }))
    expect(r.install).toBeNull()
    expect(r.build).toEqual([])
    expect(r.notes).toContain('could not tell whether build.gradle is at the root')
  })

  it('has(mvnw) rejecting suggests nothing rather than mvn', async () => {
    const r = await detectSetup(rejecting('mvnw', { 'pom.xml': POM }))
    expect(r.install).toBeNull()
    expect(r.build).toEqual([])
    expect(r.notes).toContain('could not tell whether mvnw is at the root')
  })

  it('has(pom.xml) rejecting is could-not-tell', async () => {
    const r = await detectSetup(rejecting('pom.xml', {}))
    expect(r.notes).toContain('could not tell whether pom.xml is at the root')
  })

  it.each([
    ['<project><broken></project>'],
    [''],
    ['<project><!-- never closed </project>'],
    ['<project><a></project></a>'],
  ])('a pom.xml with unbalanced tags (%j) suggests nothing and says so', async (text) => {
    const r = await detectSetup(reader({ 'pom.xml': text }))
    expect(r.install).toBeNull()
    expect(r.build).toEqual([])
    expect(r.notes).toContain('pom.xml has unbalanced tags')
  })

  it.each([
    ['<project><description>Requires Java > 8</description></project>'],
    ['<project a="1" b=\'2\'><d>Build &amp; test</d><e/></project>'],
    ['<project><!-- </project> --><a/></project>'],
    ['<project><![CDATA[ <!-- ]]><a/><b>x</b></project>'],
    ['<project><a href="x>y" b="/>"/></project>'],
    ['<?xml version="1.0"?><project/>'],
    ['<!DOCTYPE project [ <!ENTITY a "b"> ]><project/>'],
    // balanced tags is all that is checked, so these are accepted
    ['<project><description>Build & test</description></project>'],
    ['<project><a b=c/></project>'],
    ['<project a="1" a="2"/>'],
  ])('a pom.xml with balanced tags (%j) gets suggestions', async (text) => {
    const r = await detectSetup(reader({ 'pom.xml': text }))
    expect(r.build.length).toBe(1)
    expect(r.notes).not.toContain('pom.xml has unbalanced tags')
  })

  it.each([['build.gradle'], ['build.gradle.kts']])(
    '%s is never read, so a broken script still gets gradle test',
    async (file) => {
      const r = await detectSetup({
        has: async (path) => path === file,
        read: async () => {
          throw new Error('a Gradle script is not read')
        },
      })
      expect(r.build.map((b) => b.run)).toEqual(['gradle test'])
      expect(r.notes.some((n) => n.includes('parse') || n.includes('read'))).toBe(false)
    },
  )

  it('a build file that cannot be read suggests nothing and says so', async () => {
    const r = await detectSetup(reader({ 'pom.xml': POM }, { haveNotRead: ['pom.xml'] }))
    expect(r.install).toBeNull()
    expect(r.build).toEqual([])
    expect(r.notes).toContain('pom.xml could not be read')
  })
})

describe('detectSetup — Rust', () => {
  const TOML = '[package]\nname = "x"\nversion = "0.1.0"\n'

  it('with Cargo.lock, fetch and test are --locked', async () => {
    const r = await detectSetup(reader({ 'Cargo.toml': TOML, 'Cargo.lock': '' }))
    expect(r.install).toEqual({ run: 'cargo fetch --locked', because: 'Cargo.toml is at the root' })
    expect(r.build.map((b) => b.run)).toEqual([
      'cargo fmt --check',
      'cargo clippy --all-targets -- -D warnings',
      'cargo test --locked',
    ])
  })

  it('without Cargo.lock, neither is', async () => {
    const r = await detectSetup(reader({ 'Cargo.toml': TOML }))
    expect(r.install?.run).toBe('cargo fetch')
    expect(r.build.map((b) => b.run)).toEqual([
      'cargo fmt --check',
      'cargo clippy --all-targets -- -D warnings',
      'cargo test',
    ])
  })

  it('a workspace gets the same commands', async () => {
    const r = await detectSetup(reader({ 'Cargo.toml': '[workspace]\nmembers = ["a"]\n' }))
    expect(r.build.map((b) => b.name)).toEqual(['format', 'lint', 'test'])
  })

  it('the timeout note is among the notes', async () => {
    const r = await detectSetup(reader({ 'Cargo.toml': TOML }))
    expect(r.notes.some((n) => n.includes('timeout:') && n.includes('15m'))).toBe(true)
  })

  it('format and lint probe rustfmt and cargo-clippy; fetch and test probe cargo', async () => {
    const r = await detectSetup(reader({ 'Cargo.toml': TOML }))
    expect(r.install?.tool).toBeUndefined()
    expect(r.build.map((b) => b.tool)).toEqual(['rustfmt', 'cargo-clippy', undefined])
  })

  it('an unknown Cargo.lock leaves --locked off and says so', async () => {
    const r = await detectSetup({
      has: async (path) => {
        if (path === 'Cargo.lock') throw new Error('no')
        return path === 'Cargo.toml'
      },
      read: async () => TOML,
    })
    expect(r.install?.run).toBe('cargo fetch')
    expect(r.notes).toContain('could not tell whether Cargo.lock is at the root; --locked was left off')
  })

  it('a Cargo.toml that does not parse suggests nothing and says so', async () => {
    const r = await detectSetup(reader({ 'Cargo.toml': '[package\n' }))
    expect(r.install).toBeNull()
    expect(r.build).toEqual([])
    expect(r.notes).toContain('Cargo.toml does not parse')
  })

  it('a Cargo.toml that cannot be read suggests nothing and says so', async () => {
    const r = await detectSetup(reader({ 'Cargo.toml': TOML }, { haveNotRead: ['Cargo.toml'] }))
    expect(r.build).toEqual([])
    expect(r.notes).toContain('Cargo.toml could not be read')
  })

  it('a has() that rejects is could-not-tell, not absent', async () => {
    const r = await detectSetup({
      has: async () => {
        throw new Error('no')
      },
      read: async () => null,
    })
    expect(r.notes).toContain('could not tell whether a Cargo project is at the root')
  })

  it('Node keeps the suggestions when package.json is also at the root', async () => {
    const r = await detectSetup(reader({ 'package.json': pkg({ test: 'vitest' }), 'Cargo.toml': TOML }))
    expect(r.build.map((b) => b.run)).not.toContain('cargo test')
    expect(r.notes).toContain('Rust is also at the root; Node was used')
  })
})
