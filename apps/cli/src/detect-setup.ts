/**
 * Detects a repository's install and build commands (#397, #391) — the
 * seam a newcomer's setup reads before asking `--install`/`--build` at
 * `setup-build.ts`'s questions.
 *
 * **Pure.** Everything here is a function of what `SetupReader` answers;
 * nothing is asked and nothing is run. A command this detects is a
 * suggestion, never a silent guess — `DetectedSetup.notes` and `.skipped`
 * carry every reason a thing was not suggested, for `setup-build.ts` to
 * print before it asks.
 */

import { parse as parseToml } from 'smol-toml'

/** The file seam: a local directory or a GitHub default branch. */
export interface SetupReader {
  /**
   * Whether `path` exists at the root. Separate from `read`, because the
   * GitHub contents API leaves `content` empty for a file between 1 and
   * 100 MB — a monorepo's `pnpm-lock.yaml` is often that size, and a `has`
   * built on `read` alone would call the biggest lockfiles absent.
   */
  has(path: string): Promise<boolean>
  read(path: string): Promise<string | null>
}

/**
 * Suggests nothing: `has` rejects rather than resolving `false`, so
 * `detectInstall`/`detectSetup` below read every path through it as "could
 * not tell" rather than a confirmed absence — resolving `false` the way a
 * real check's negative does would print a lockfile or a `package.json` as
 * missing from a repository that has both (#431 fix round, finding 2).
 * `read` stays `null`, already every reader's "could not get this content"
 * answer.
 */
export const EMPTY_SETUP_READER: SetupReader = {
  has: async () => {
    throw new Error('nothing can be read here')
  },
  read: async () => null,
}

export interface DetectedSetup {
  install: { run: string; because: string } | null
  build: { name: string; run: string; because: string }[]
  skipped: { script: string; why: string }[]
  notes: string[]
}

/** What one stack's detector says: whether it is at the root, and what it would run. */
export type StackFinding = { presence: 'present' | 'absent' | 'unknown' } & DetectedSetup

export interface StackDetector {
  /** The word a note names this stack by. */
  stack: string
  detect(reader: SetupReader): Promise<StackFinding>
}

type Manager = 'pnpm' | 'yarn' | 'npm'

const LOCKFILES: { path: string; manager: Manager; install: string }[] = [
  { path: 'pnpm-lock.yaml', manager: 'pnpm', install: 'pnpm install --frozen-lockfile' },
  { path: 'yarn.lock', manager: 'yarn', install: 'yarn install --frozen-lockfile' },
  { path: 'package-lock.json', manager: 'npm', install: 'npm ci' },
]

/** In the order the ticket's table asks for: format, lint, typecheck, test. */
const BUILD_ORDER: { key: string; names: readonly string[] }[] = [
  { key: 'format', names: ['fmt:check', 'format:check'] },
  { key: 'lint', names: ['lint'] },
  { key: 'typecheck', names: ['typecheck'] },
  { key: 'test', names: ['test'] },
]

/** A script name that says, by itself, "this does not fit inside a pass" (CLAUDE.md, 803s). */
const INTEGRATION_NAME = /integration|e2e/i

/** A command that needs a browser or a running app — found, never picked (`propose.ts`'s `NEEDS_A_WORLD`). */
const NEEDS_A_WORLD = /(e2e|playwright|cypress|puppeteer|selenium|webdriver)/i

function runFor(manager: Manager | null, name: string): string {
  if (manager === 'pnpm') return `pnpm ${name}`
  if (manager === 'yarn') return `yarn ${name}`
  return `npm run ${name}`
}

/** Why a script, found by name or by its command, is skipped rather than suggested. */
function skipReasonFor(name: string, command: string): string | null {
  if (INTEGRATION_NAME.test(name)) {
    return `"${name}" looks like an integration or end-to-end check — those do not fit inside a pass (CLAUDE.md, ~803s)`
  }
  if (INTEGRATION_NAME.test(command) || NEEDS_A_WORLD.test(command)) {
    return `"${name}" runs "${command}", which looks like an integration or end-to-end check — needing a browser or a running app, a worktree has neither`
  }
  return null
}

async function detectInstall(reader: SetupReader): Promise<{
  install: DetectedSetup['install']
  manager: Manager | null
  notes: string[]
  uncertain: boolean
}> {
  const notes: string[] = []
  const present: typeof LOCKFILES = []
  // A lockfile whose `has` rejected is neither present nor confirmed absent
  // — the note below says so instead of claiming the root has none (#431
  // fix round, finding 2).
  let uncertain = false
  for (const lockfile of LOCKFILES) {
    try {
      if (await reader.has(lockfile.path)) present.push(lockfile)
    } catch {
      uncertain = true
    }
  }
  if (present.length === 0) {
    notes.push(uncertain ? 'could not tell whether a lockfile is at the root' : 'no lockfile at the root')
    return { install: null, manager: null, notes, uncertain }
  }
  const [chosen, ...rest] = present
  for (const other of rest) {
    notes.push(`${other.path} is also at the root; ${chosen!.path} was used`)
  }
  return {
    install: { run: chosen!.install, because: `${chosen!.path} is at the root` },
    manager: chosen!.manager,
    notes,
    uncertain,
  }
}

const nodeDetector: StackDetector = {
  stack: 'Node',
  async detect(reader) {
    const { install, manager, notes, uncertain } = await detectInstall(reader)
    // A lockfile alone is Node (the note below says the package.json is
    // missing), so presence is "anything confirmed", not "has package.json".
    const lockfileFound = install !== null
    const finding = (
      presence: StackFinding['presence'],
      build: DetectedSetup['build'],
      skipped: DetectedSetup['skipped'],
    ) => ({
      presence,
      install,
      build,
      skipped,
      notes,
    })
    const unsure = (): StackFinding['presence'] => (uncertain ? 'unknown' : 'absent')

    const build: DetectedSetup['build'] = []
    const skipped: DetectedSetup['skipped'] = []

    let hasPackageJson: boolean
    try {
      hasPackageJson = await reader.has('package.json')
    } catch {
      notes.push('could not tell whether package.json is at the root')
      return finding(lockfileFound ? 'present' : 'unknown', build, skipped)
    }

    if (!hasPackageJson) {
      notes.push('no package.json at the root')
      return finding(lockfileFound ? 'present' : unsure(), build, skipped)
    }

    const text = await reader.read('package.json')
    if (text === null) {
      notes.push('package.json could not be read')
      return finding('present', build, skipped)
    }

    let scripts: Record<string, string>
    try {
      const parsed = JSON.parse(text) as { scripts?: Record<string, unknown> }
      scripts = Object.fromEntries(
        Object.entries(parsed.scripts ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      )
    } catch {
      notes.push('package.json does not parse')
      return finding('present', build, skipped)
    }

    for (const [name, command] of Object.entries(scripts)) {
      const why = skipReasonFor(name, command)
      if (why !== null) skipped.push({ script: name, why })
    }
    const skippedNames = new Set(skipped.map((s) => s.script))

    for (const { key, names } of BUILD_ORDER) {
      const name = names.find((n) => Object.hasOwn(scripts, n))
      if (name === undefined || skippedNames.has(name)) continue
      const command = scripts[name]!
      build.push({ name: key, run: runFor(manager, name), because: `\`${name}\` runs \`${command}\`` })
    }

    return finding('present', build, skipped)
  },
}

type PythonManager = 'uv' | 'poetry'

const PYTHON_LOCKFILES: { path: string; manager: PythonManager; install: string }[] = [
  { path: 'uv.lock', manager: 'uv', install: 'uv sync --frozen' },
  { path: 'poetry.lock', manager: 'poetry', install: 'poetry install --no-interaction' },
]

/** Tri-state: `has` rejecting is "could not tell", never absent. */
async function hasOrUnknown(reader: SetupReader, path: string): Promise<boolean | 'unknown'> {
  try {
    return await reader.has(path)
  } catch {
    return 'unknown'
  }
}

type PyTool = {
  key: string
  run: string
  /** The `[tool.*]` table in pyproject.toml that configures it, or null. */
  table: readonly string[] | null
  /** Standalone files (or a directory) that configure it. */
  files: readonly string[]
}

/** In the order the ticket asks for; only what the project configures is suggested. */
const PYTHON_TOOLS: readonly PyTool[] = [
  { key: 'format', run: 'ruff format --check .', table: ['ruff'], files: ['ruff.toml'] },
  { key: 'lint', run: 'ruff check .', table: ['ruff'], files: ['ruff.toml'] },
  { key: 'typecheck', run: 'mypy .', table: ['mypy'], files: ['mypy.ini'] },
  { key: 'test', run: 'pytest', table: ['pytest', 'ini_options'], files: ['pytest.ini', 'tests'] },
]

function tableAt(root: unknown, path: readonly string[]): boolean {
  let node: unknown = root
  for (const key of path) {
    if (typeof node !== 'object' || node === null || !Object.hasOwn(node, key)) return false
    node = (node as Record<string, unknown>)[key]
  }
  return typeof node === 'object' && node !== null
}

const pythonDetector: StackDetector = {
  stack: 'Python',
  async detect(reader) {
    const notes: string[] = []
    const none = (presence: StackFinding['presence']): StackFinding => ({
      presence,
      install: null,
      build: [],
      skipped: [],
      notes,
    })

    const lockfiles: typeof PYTHON_LOCKFILES = []
    let uncertain = false
    for (const lockfile of PYTHON_LOCKFILES) {
      const found = await hasOrUnknown(reader, lockfile.path)
      if (found === 'unknown') uncertain = true
      else if (found) lockfiles.push(lockfile)
    }
    const pyproject = await hasOrUnknown(reader, 'pyproject.toml')
    const requirements = await hasOrUnknown(reader, 'requirements.txt')
    if (pyproject === 'unknown' || requirements === 'unknown') uncertain = true

    const chosen = lockfiles[0]
    if (chosen === undefined && pyproject !== true && requirements !== true) {
      if (uncertain) {
        notes.push('could not tell whether a Python project is at the root')
        return none('unknown')
      }
      return none('absent')
    }

    let install: DetectedSetup['install'] = null
    if (chosen !== undefined) {
      install = { run: chosen.install, because: `${chosen.path} is at the root` }
      for (const other of lockfiles.slice(1)) notes.push(`${other.path} is also at the root; ${chosen.path} was used`)
    } else if (requirements === true) {
      notes.push(
        'requirements.txt is at the root with no uv.lock or poetry.lock: create a virtual environment and type the install command',
      )
    } else {
      notes.push('no uv.lock or poetry.lock at the root')
    }

    // pyproject.toml: a table that is absent is "not configured"; a file that
    // cannot be read or parsed is "could not tell", and nothing comes from it.
    let toml: unknown = null
    if (pyproject === 'unknown') {
      notes.push('could not tell whether pyproject.toml is at the root')
    } else if (pyproject) {
      const text = await reader.read('pyproject.toml')
      if (text === null) {
        notes.push('pyproject.toml could not be read')
      } else {
        try {
          toml = parseToml(text)
        } catch {
          notes.push('pyproject.toml does not parse')
        }
      }
    }
    const tool = typeof toml === 'object' && toml !== null ? (toml as { tool?: unknown }).tool : undefined

    if (chosen === undefined) {
      notes.push('build commands are suggested only through uv or poetry, which need uv.lock or poetry.lock')
      return { ...none('present'), install }
    }

    const build: DetectedSetup['build'] = []
    const unreadable = new Set<string>()
    for (const { key, run, table, files } of PYTHON_TOOLS) {
      let because: string | null = null
      if (table !== null && tableAt(tool, table)) because = `[tool.${table.join('.')}] is in pyproject.toml`
      for (const file of files) {
        if (because !== null) break
        const found = await hasOrUnknown(reader, file)
        if (found === 'unknown') {
          if (!unreadable.has(file)) notes.push(`could not tell whether ${file} is at the root`)
          unreadable.add(file)
        } else if (found) because = `${file}${file === 'tests' ? '/' : ''} is at the root`
      }
      if (because !== null) build.push({ name: key, run: `${chosen.manager} run ${run}`, because })
    }
    return { presence: 'present', install, build, skipped: [], notes }
  },
}

export const DETECTORS: readonly StackDetector[] = [nodeDetector, pythonDetector]

/**
 * Asks each detector in order, over the same reader. The first stack present
 * supplies `install` and `build`; every later one is only named in a note, so
 * nothing is merged into a command nobody was shown. A stack that could not
 * tell keeps its notes — its "could not tell" is never turned into silence.
 */
export async function detectSetup(
  reader: SetupReader,
  detectors: readonly StackDetector[] = DETECTORS,
): Promise<DetectedSetup> {
  const findings: { stack: string; found: StackFinding }[] = []
  for (const detector of detectors) findings.push({ stack: detector.stack, found: await detector.detect(reader) })

  const first = findings.find((f) => f.found.presence === 'present')
  if (first === undefined) {
    return { install: null, build: [], skipped: [], notes: findings.flatMap((f) => f.found.notes) }
  }
  const notes = [...first.found.notes]
  for (const other of findings) {
    if (other === first) continue
    if (other.found.presence === 'present') {
      notes.push(`${other.stack} is also at the root; ${first.stack} was used`)
    } else if (other.found.presence === 'unknown') {
      notes.push(...other.found.notes)
    }
  }
  const { install, build, skipped } = first.found
  return { install, build, skipped, notes }
}
