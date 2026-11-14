import { mkdir, lstat, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { Effect, type Scope } from 'effect'

import { AgentHostFailed } from './hook-config.ts'

/**
 * A sandboxed Claude Code run's own configuration directory (0127 §8).
 *
 * A run inside srt cannot read the operator's login, so it gets a directory of
 * its own: the hook settings Lingtai writes, and copies of the operator's
 * user-level `CLAUDE.md`, `skills/` and `agents/`. It does not get MCP servers,
 * plugins, commands or `settings.json` from the operator's directory, and not
 * the login. `claude-sandbox.ts` wraps the run and sets
 * `CLAUDE_CONFIG_DIR` to it (#1150).
 *
 * **`dir` and `source` are passed in.** `packages/agent` does not learn where
 * `~/.lingtai` or `~/.claude` is (`RunRequest`'s comment, `runtime.ts`); the
 * conductor names the first (`claudeConfigDirFor`) and S4b the second.
 *
 * **A link is copied as its target, never as a link**: on the operator's
 * machine `~/.claude/skills` is commonly a symlink, and a copied link would
 * hand the run the operator's live directory. A link whose target is gone is
 * skipped with one trace line.
 *
 * "Read-only" is the sandbox's `denyWrite`, S4b's, and not a chmod here.
 *
 * **No file's contents, and no token, ever reaches an error or a trace**: both
 * carry a path and an error code.
 */

/** What this module asks of a directory entry. */
export interface RunDirStat {
  isDirectory(): boolean
  isFile(): boolean
  isSymbolicLink(): boolean
  /** Permission bits; absent from a fake that does not model them. */
  mode?: number
}

/** The filesystem, as a port: a unit test hands in a fake. Failures carry a `code`, as Node's do. */
export interface RunDirFs {
  lstat(path: string): Effect.Effect<RunDirStat, unknown>
  /** Follows links. */
  stat(path: string): Effect.Effect<RunDirStat, unknown>
  realpath(path: string): Effect.Effect<string, unknown>
  readdir(path: string): Effect.Effect<readonly string[], unknown>
  readFile(path: string): Effect.Effect<Uint8Array, unknown>
  writeFile(path: string, data: Uint8Array | string, mode: number): Effect.Effect<void, unknown>
  /** Not recursive unless asked: an existing directory is `EEXIST`. */
  mkdir(path: string, options: { recursive: boolean; mode: number }): Effect.Effect<void, unknown>
  rm(path: string): Effect.Effect<void, unknown>
}

const io = <A>(f: () => Promise<A>): Effect.Effect<A, unknown> => Effect.tryPromise({ try: f, catch: (e) => e })

/** `node:fs/promises`, for the one caller that is not a test. */
export const liveRunDirFs: RunDirFs = {
  lstat: (p) => io(() => lstat(p)),
  stat: (p) => io(() => stat(p)),
  realpath: (p) => io(() => realpath(p)),
  readdir: (p) => io(() => readdir(p)),
  readFile: (p) => io(() => readFile(p)),
  writeFile: (p, data, mode) => io(() => writeFile(p, data, { mode })),
  mkdir: (p, o) => io(() => mkdir(p, o).then(() => undefined)),
  rm: (p) => io(() => rm(p, { recursive: true, force: true })),
}

export interface ClaudeRunDirectoryOptions {
  /** The operator's Claude directory (`~/.claude`), named by the caller. */
  source: string
  /** The run's user-level settings, written as `<dir>/settings.json`: `{ sandbox: { enabled: false } }` and no hooks, which are `--settings`'s. */
  settings: unknown
  /** One line at a time. Carries paths and error codes, never a value read from a file. */
  trace: (line: string) => void
}

/** The three user-level items a run keeps. */
export const COPIED_ITEMS = ['CLAUDE.md', 'skills', 'agents'] as const

/** What each top-level item must be, once a link is followed. */
const SHAPE_OF: Record<(typeof COPIED_ITEMS)[number], 'file' | 'directory'> = {
  'CLAUDE.md': 'file',
  skills: 'directory',
  agents: 'directory',
}

/** A copy is the run's own, `0600` — and keeps the owner's execute bit, so a skill's helper script still runs. */
const copyMode = (s: RunDirStat): number => (((s.mode ?? 0) & 0o111) !== 0 ? 0o700 : 0o600)

const codeOf = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : 'unknown'
}

const failed = (operation: string, path: string, err: unknown) =>
  new AgentHostFailed({ operation: 'claude-run-dir', detail: `${operation} ${path}: ${codeOf(err)}` })

/**
 * Make `dir`, fill it, and remove it when the scope closes — on success and on
 * failure. A `dir` that exists is refused by name, and that refusal never
 * releases anything, so one run cannot delete another's directory. A removal
 * that fails is traced and does not fail: the next daemon start's sweep is the
 * backstop.
 */
export const prepareClaudeRunDirectory = (
  dir: string,
  options: ClaudeRunDirectoryOptions,
  fs: RunDirFs = liveRunDirFs,
): Effect.Effect<readonly string[], AgentHostFailed, Scope.Scope> =>
  Effect.gen(function* () {
    yield* Effect.acquireRelease(
      fs.mkdir(dirname(dir), { recursive: true, mode: 0o700 }).pipe(
        Effect.flatMap(() => fs.mkdir(dir, { recursive: false, mode: 0o700 })),
        Effect.mapError((err) =>
          codeOf(err) === 'EEXIST'
            ? new AgentHostFailed({
                operation: 'claude-run-dir',
                detail: `${dir} already exists; a run's directory is its own`,
              })
            : failed('make', dir, err),
        ),
      ),
      () =>
        fs
          .rm(dir)
          .pipe(Effect.catch((err) => Effect.sync(() => options.trace(`could not remove ${dir}: ${codeOf(err)}`)))),
    )

    yield* fs
      .writeFile(join(dir, 'settings.json'), `${JSON.stringify(options.settings, null, 2)}\n`, 0o600)
      .pipe(Effect.mapError((err) => failed('write', join(dir, 'settings.json'), err)))

    // The top-level paths that exist: an absent item or a dangling link is not here, so the sandbox is never told
    // to allow a path that was not made.
    const written = [join(dir, 'settings.json')]
    for (const name of COPIED_ITEMS) {
      const copied = yield* copyItem(fs, join(options.source, name), join(dir, name), options.trace, [], SHAPE_OF[name])
      if (copied) written.push(join(dir, name))
    }
    return written
  })

/** Copy one entry as what it resolves to, or skip it when it is absent or a dangling link. */
const copyItem = (
  fs: RunDirFs,
  src: string,
  dst: string,
  trace: (line: string) => void,
  ancestors: readonly string[],
  expected?: 'file' | 'directory',
): Effect.Effect<boolean, AgentHostFailed> =>
  Effect.gen(function* () {
    const link = yield* fs.lstat(src).pipe(
      Effect.map((s): RunDirStat | null => s),
      Effect.catch((err) => (codeOf(err) === 'ENOENT' ? Effect.succeed(null) : Effect.fail(failed('read', src, err)))),
    )
    if (link === null) return false

    let resolved: RunDirStat = link
    if (link.isSymbolicLink()) {
      const target = yield* fs.stat(src).pipe(
        Effect.map((s): RunDirStat | null => s),
        Effect.catch((err) =>
          codeOf(err) === 'ENOENT' ? Effect.succeed(null) : Effect.fail(failed('read', src, err)),
        ),
      )
      if (target === null) {
        trace(`skipped a dangling link: ${src}`)
        return false
      }
      resolved = target
    }

    if (expected !== undefined && (expected === 'directory' ? !resolved.isDirectory() : !resolved.isFile())) {
      return yield* Effect.fail(
        new AgentHostFailed({ operation: 'claude-run-dir', detail: `${src} must be a ${expected}` }),
      )
    }

    if (resolved.isDirectory()) {
      const real = yield* fs.realpath(src).pipe(Effect.mapError((err) => failed('read', src, err)))
      if (ancestors.includes(real)) {
        return yield* Effect.fail(
          new AgentHostFailed({ operation: 'claude-run-dir', detail: `${src} is a link loop, which is not copied` }),
        )
      }
      yield* fs.mkdir(dst, { recursive: false, mode: 0o700 }).pipe(Effect.mapError((err) => failed('make', dst, err)))
      const names = yield* fs.readdir(src).pipe(Effect.mapError((err) => failed('read', src, err)))
      for (const name of names) {
        yield* copyItem(fs, join(src, name), join(dst, name), trace, [...ancestors, real])
      }
      return true
    }

    if (resolved.isFile()) {
      const data = yield* fs.readFile(src).pipe(Effect.mapError((err) => failed('read', src, err)))
      yield* fs.writeFile(dst, data, copyMode(resolved)).pipe(Effect.mapError((err) => failed('write', dst, err)))
      return true
    }

    return yield* Effect.fail(
      new AgentHostFailed({ operation: 'claude-run-dir', detail: `${src} is neither a file nor a directory` }),
    )
  })
