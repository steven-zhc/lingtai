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

async function detectInstall(
  reader: SetupReader,
): Promise<{ install: DetectedSetup['install']; manager: Manager | null; notes: string[] }> {
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
    return { install: null, manager: null, notes }
  }
  const [chosen, ...rest] = present
  for (const other of rest) {
    notes.push(`${other.path} is also at the root; ${chosen!.path} was used`)
  }
  return {
    install: { run: chosen!.install, because: `${chosen!.path} is at the root` },
    manager: chosen!.manager,
    notes,
  }
}

export async function detectSetup(reader: SetupReader): Promise<DetectedSetup> {
  const { install, manager, notes } = await detectInstall(reader)

  const build: DetectedSetup['build'] = []
  const skipped: DetectedSetup['skipped'] = []

  let hasPackageJson: boolean
  try {
    hasPackageJson = await reader.has('package.json')
  } catch {
    notes.push('could not tell whether package.json is at the root')
    return { install, build, skipped, notes }
  }

  if (!hasPackageJson) {
    notes.push('no package.json at the root')
    return { install, build, skipped, notes }
  }

  const text = await reader.read('package.json')
  if (text === null) {
    notes.push('package.json could not be read')
    return { install, build, skipped, notes }
  }

  let scripts: Record<string, string>
  try {
    const parsed = JSON.parse(text) as { scripts?: Record<string, unknown> }
    scripts = Object.fromEntries(
      Object.entries(parsed.scripts ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    )
  } catch {
    notes.push('package.json does not parse')
    return { install, build, skipped, notes }
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

  return { install, build, skipped, notes }
}
