/**
 * Syncs the raster images under `doc/` with the R2 bucket `lingtai-docs` (#1469).
 *
 * Run by `scripts/doc-images.ts` (`pnpm images:upload|download|list`). Nothing
 * here is imported by `entry.ts` or `commands.ts`: it is a developer script's
 * logic, kept in a package so it is typechecked and unit-tested.
 *
 * The object store and the filesystem are injected, so no test reaches the
 * network, and credentials are checked before the store is ever built. Nothing
 * is ever planned for deletion: `Plan` has no such member.
 */
import { createHash, randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import { link, lstat, mkdir, readFile, readdir, realpath, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { posix } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Effect, Redacted } from 'effect'

export const BUCKET = 'lingtai-docs'
export type Command = 'upload' | 'download' | 'list'
export const COMMANDS: readonly Command[] = ['upload', 'download', 'list']

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

/** The content type for a key's extension, or undefined when it is not a listed image. */
export const contentTypeOf = (key: string): string | undefined => {
  const dot = key.lastIndexOf('.')
  return dot < 0
    ? undefined
    : Object.hasOwn(CONTENT_TYPES, key.slice(dot + 1))
      ? CONTENT_TYPES[key.slice(dot + 1)]
      : undefined
}

/** A key this tool would itself produce: relative, `/`-separated, no `.`/`..`, a lower-case listed extension. */
export const validKey = (key: string): boolean =>
  contentTypeOf(key) !== undefined &&
  !key.startsWith('/') &&
  !key.includes('\\') &&
  !key.includes('\0') &&
  key.split('/').every((s) => s !== '' && s !== '.' && s !== '..') &&
  posix.normalize(key) === key

// ── credentials ─────────────────────────────────────────────────────────────

export const CREDENTIAL_NAMES = [
  'LINGTAI_R2_ACCOUNT_ID',
  'LINGTAI_R2_ACCESS_KEY_ID',
  'LINGTAI_R2_SECRET_ACCESS_KEY',
] as const

export interface Credentials {
  readonly accountId: Redacted.Redacted<string>
  readonly accessKeyId: Redacted.Redacted<string>
  readonly secretAccessKey: Redacted.Redacted<string>
}

/** The three values, or every name that is missing or empty — names only, never values. */
export const credentials = (
  env: Readonly<Record<string, string | undefined>>,
): { readonly ok: true; readonly value: Credentials } | { readonly ok: false; readonly missing: readonly string[] } => {
  const missing = CREDENTIAL_NAMES.filter((n) => (env[n] ?? '') === '')
  if (missing.length > 0) return { ok: false, missing }
  return {
    ok: true,
    value: {
      accountId: Redacted.make(env[CREDENTIAL_NAMES[0]] as string),
      accessKeyId: Redacted.make(env[CREDENTIAL_NAMES[1]] as string),
      secretAccessKey: Redacted.make(env[CREDENTIAL_NAMES[2]] as string),
    },
  }
}

export class MissingCredentials extends Error {
  readonly _tag = 'MissingCredentials'
  readonly missing: readonly string[]
  constructor(missing: readonly string[]) {
    super(`missing environment variables: ${missing.join(', ')}`)
    this.missing = missing
  }
}

/** A request or file operation that failed; the message is built from names and a status, never from the SDK's own text. */
export class SyncFailed extends Error {
  readonly _tag = 'SyncFailed'
}

const describe = (e: unknown): string => {
  const o = (e ?? {}) as { name?: unknown; code?: unknown; $metadata?: { httpStatusCode?: unknown } }
  const name = typeof o.name === 'string' ? o.name : 'Error'
  const code = typeof o.code === 'string' ? ` ${o.code}` : ''
  const status = typeof o.$metadata?.httpStatusCode === 'number' ? ` HTTP ${o.$metadata.httpStatusCode}` : ''
  return `${name}${code}${status}`
}

// ── the plan ────────────────────────────────────────────────────────────────

export interface LocalFile {
  readonly key: string
  readonly md5: string
}
export interface RemoteObject {
  readonly key: string
  readonly etag?: string | undefined
}
export interface Plan {
  readonly upload: readonly string[]
  readonly replace: readonly string[]
  readonly skip: readonly string[]
  readonly download: readonly string[]
  readonly remoteOnlyRefused: readonly string[]
}

/** A single-part ETag is the quoted MD5; a multipart one (`-`) or none is never equal. */
const sameMd5 = (etag: string | undefined, md5: string): boolean => {
  if (etag === undefined) return false
  const bare = etag.replace(/^"|"$/g, '')
  return !bare.includes('-') && bare.toLowerCase() === md5
}

export const plan = (local: readonly LocalFile[], remote: readonly RemoteObject[]): Plan => {
  const remoteBy = new Map(remote.map((r) => [r.key, r]))
  const localKeys = new Set(local.map((l) => l.key))
  const upload: string[] = []
  const replace: string[] = []
  const skip: string[] = []
  for (const l of local) {
    const r = remoteBy.get(l.key)
    if (r === undefined) upload.push(l.key)
    else if (sameMd5(r.etag, l.md5)) skip.push(l.key)
    else replace.push(l.key)
  }
  const download: string[] = []
  const remoteOnlyRefused: string[] = []
  for (const r of remote) {
    if (localKeys.has(r.key)) continue
    if (validKey(r.key)) download.push(r.key)
    else remoteOnlyRefused.push(r.key)
  }
  return { upload, replace, skip, download, remoteOnlyRefused }
}

// ── the seams ───────────────────────────────────────────────────────────────

export interface ObjectStore {
  readonly list: (
    token?: string,
  ) => Promise<{ readonly objects: readonly RemoteObject[]; readonly next?: string | undefined }>
  readonly put: (key: string, body: Uint8Array, contentType: string) => Promise<void>
  readonly get: (key: string) => Promise<Uint8Array>
}
export interface StoreConfig {
  readonly endpoint: string
  readonly region: string
  readonly accessKeyId: string
  readonly secretAccessKey: string
}
export type StoreFactory = (config: StoreConfig) => ObjectStore

export interface DocFs {
  /** Every regular file's key under the root (symlinks skipped), any extension. */
  readonly walk: () => Promise<readonly string[]>
  readonly read: (key: string) => Promise<Uint8Array>
  /** `exists` when a file is already there; never overwrites. */
  readonly write: (key: string, data: Uint8Array) => Promise<'written' | 'exists'>
}

/** What is at `path` without following a link, or undefined when nothing is. */
const lstatOrNone = (path: string): Promise<Stats | undefined> =>
  lstat(path).then(
    (st) => st,
    (e: unknown) => ((e as { code?: string }).code === 'ENOENT' ? undefined : Promise.reject(e)),
  )

const refuse = (path: string, why: string): Promise<never> =>
  Promise.reject(Object.assign(new Error(`${why}: ${path}`), { name: 'PathConflict' }))

/**
 * Makes each directory under `base` one at a time, and refuses a segment that is
 * a symlink or anything but a directory — `mkdir -p` would follow the first and
 * mistake the second for success, so the write could land outside the root.
 */
const ensureRealDirs = (base: string, segments: readonly string[], at = base): Promise<void> => {
  const [head, ...rest] = segments
  if (head === undefined) return Promise.resolve()
  const next = join(at, head)
  return lstatOrNone(next)
    .then((st) =>
      st === undefined
        ? mkdir(next).then(
            () => undefined,
            (e: unknown) =>
              (e as { code?: string }).code === 'EEXIST' ? lstatOrNone(next).then(check(next)) : Promise.reject(e),
          )
        : check(next)(st),
    )
    .then(() => ensureRealDirs(base, rest, next))
}
const check =
  (path: string) =>
  (st: Stats | undefined): Promise<void> =>
    st?.isDirectory() === true && !st.isSymbolicLink() ? Promise.resolve() : refuse(path, 'not a plain directory')

/**
 * Writes `data` to a temporary name beside `target`, then links it into place:
 * `link` never replaces, so a file already there is `exists`, and a failed or
 * short write leaves only the temporary name, which is removed — `target` is
 * never a partial file. Anything else at `target` (a directory, a link) fails.
 *
 * Containment is `ensureRealDirs` (no segment is a link) and writing through
 * the directory's real path. It is not a guarantee against a process that swaps
 * a directory for a link inside `doc/` while this runs: Node has no
 * `openat`, so nothing here can close that, and a check that claimed to would
 * only be a larger window. Nothing is deleted but the temporary name this call
 * created, which `wx` made, so no path is ever unlinked that this call did not
 * create. The temporary name is a fixed length, so it never outgrows a long
 * target name.
 */
const writeWhole = (target: string, data: Uint8Array): Promise<'written' | 'exists'> => {
  const tmp = join(dirname(target), `.${randomUUID()}.tmp`)
  const dropTmp = (): Promise<void> =>
    unlink(tmp).then(
      () => undefined,
      () => undefined,
    )
  return writeFile(tmp, data, { flag: 'wx' })
    .then(() => link(tmp, target))
    .then(
      () => dropTmp().then(() => 'written' as const),
      (e: unknown) =>
        dropTmp().then(() =>
          (e as { code?: string }).code === 'EEXIST'
            ? lstatOrNone(target).then((st) =>
                st?.isFile() === true && !st.isSymbolicLink()
                  ? ('exists' as const)
                  : refuse(target, 'not a regular file'),
              )
            : Promise.reject(e),
        ),
    )
}

export const nodeFs = (root: string): DocFs => ({
  walk: () =>
    readdir(root, { recursive: true, withFileTypes: true }).then((entries) =>
      entries
        .filter((e) => e.isFile())
        .map((e) =>
          resolve(e.parentPath, e.name)
            .slice(resolve(root).length + 1)
            .split(sep)
            .join('/'),
        ),
    ),
  read: (key) => readFile(resolve(root, key)),
  write: (key, data) => {
    const base = resolve(root)
    const target = resolve(base, key)
    if (!target.startsWith(base + sep)) return Promise.reject(new Error('key escapes the root'))
    const segments = relative(base, dirname(target))
      .split(sep)
      .filter((s) => s !== '')
    return ensureRealDirs(base, segments)
      .then(() => realpath(base))
      .then((real) => writeWhole(join(real, ...segments, basename(target)), data))
  },
})

/** `doc/`, found from this file rather than the working directory. */
export const docRoot = (): string => fileURLToPath(new URL('../../../doc/', import.meta.url))

// ── the run ─────────────────────────────────────────────────────────────────

export interface Report {
  readonly lines: readonly string[]
  readonly failed: number
}

const io = <A>(label: string, f: () => Promise<A>): Effect.Effect<A, SyncFailed> =>
  Effect.tryPromise({ try: f, catch: (e) => new SyncFailed(`${label}: ${describe(e)}`) })

const listAll = (store: ObjectStore): Effect.Effect<readonly RemoteObject[], SyncFailed> =>
  Effect.gen(function* () {
    const all: RemoteObject[] = []
    let token: string | undefined
    do {
      const page = yield* io('list', () => store.list(token))
      all.push(...page.objects)
      token = page.next
    } while (token !== undefined)
    return all
  })

const md5Of = (data: Uint8Array): string => createHash('md5').update(data).digest('hex')

/** Per-key work: its line, and whether it failed. */
type Outcome = { readonly line: string; readonly failed: boolean; readonly verb: string }
const attempt = (
  key: string,
  ok: string,
  work: Effect.Effect<string | undefined, SyncFailed>,
): Effect.Effect<Outcome> =>
  Effect.match(work, {
    onFailure: (e): Outcome => ({ line: `failed   ${key}  ${e.message}`, failed: true, verb: 'failed' }),
    onSuccess: (s): Outcome => ({ line: `${s ?? ok}   ${key}`, failed: false, verb: s ?? ok }),
  })

export const run = (
  command: Command,
  deps: {
    readonly env: Readonly<Record<string, string | undefined>>
    readonly store: StoreFactory
    readonly fs: DocFs
  },
): Effect.Effect<Report, MissingCredentials | SyncFailed> =>
  Effect.gen(function* () {
    const creds = credentials(deps.env)
    if (!creds.ok) return yield* Effect.fail(new MissingCredentials(creds.missing))
    const account = Redacted.value(creds.value.accountId)
    const store = deps.store({
      endpoint: `https://${account}.r2.cloudflarestorage.com`,
      region: 'auto',
      accessKeyId: Redacted.value(creds.value.accessKeyId),
      secretAccessKey: Redacted.value(creds.value.secretAccessKey),
    })

    const keys = (yield* io('walk', () => deps.fs.walk())).filter(validKey).sort()
    // A file that cannot be read is reported and set aside, never fatal: download
    // only needs to know it exists, and upload carries on with the others.
    const reads = yield* Effect.forEach(keys, (key) =>
      io(key, () => deps.fs.read(key)).pipe(
        Effect.match({
          onFailure: (e) => ({ key, error: e.message }),
          onSuccess: (data) => ({ key, md5: md5Of(data) }),
        }),
      ),
    )
    const local: LocalFile[] = []
    const unreadable: string[] = []
    const unreadableLines: string[] = []
    for (const r of reads) {
      if ('error' in r) {
        unreadable.push(r.key)
        unreadableLines.push(`failed   ${r.key}  ${r.error}`)
      } else local.push(r)
    }
    const remote = yield* listAll(store)
    const unreadableSet = new Set(unreadable)
    const planned = plan(local, remote)
    const p: Plan = { ...planned, download: planned.download.filter((k) => !unreadableSet.has(k)) }
    const lines: string[] = []

    if (command === 'list') {
      const status = new Map<string, string>()
      for (const k of unreadable) status.set(k, 'local (unreadable)')
      for (const k of p.skip) status.set(k, 'both')
      for (const k of p.replace) status.set(k, 'differs')
      for (const k of p.upload) status.set(k, 'local only')
      for (const k of p.download) status.set(k, 'remote only')
      for (const k of p.remoteOnlyRefused) status.set(k, 'remote only (refused: not a valid key)')
      for (const k of [...status.keys()].sort()) lines.push(`${(status.get(k) as string).padEnd(12)} ${k}`)
      lines.push(
        `${p.skip.length} both, ${p.replace.length} differs, ${p.upload.length} local only, ${p.download.length + p.remoteOnlyRefused.length} remote only, ${unreadable.length} unreadable`,
      )
      return { lines, failed: unreadable.length }
    }

    let outcomes: readonly Outcome[]
    if (command === 'upload') {
      const put = (key: string, verb: string) =>
        attempt(
          key,
          verb,
          io(key, () => deps.fs.read(key)).pipe(
            Effect.flatMap((data) => io(key, () => store.put(key, data, contentTypeOf(key) as string))),
            Effect.map(() => undefined),
          ),
        )
      const done = yield* Effect.forEach(
        [...p.upload.map((k) => [k, 'uploaded'] as const), ...p.replace.map((k) => [k, 'replaced'] as const)],
        ([k, verb]) => put(k, verb),
        { concurrency: 4 },
      )
      outcomes = done
      lines.push(...unreadableLines, ...done.map((o) => o.line))
      lines.push(
        `${done.filter((o) => o.verb === 'uploaded').length} uploaded, ${done.filter((o) => o.verb === 'replaced').length} replaced, ${p.skip.length} skipped, ${done.filter((o) => o.failed).length + unreadable.length} failed`,
      )
    } else {
      const done = yield* Effect.forEach(
        p.download,
        (key) =>
          attempt(
            key,
            'downloaded',
            io(key, () => store.get(key)).pipe(
              Effect.flatMap((data) => io(key, () => deps.fs.write(key, data))),
              Effect.map((r) => (r === 'exists' ? 'skipped' : undefined)),
            ),
          ),
        { concurrency: 4 },
      )
      outcomes = done
      lines.push(...done.map((o) => o.line))
      for (const k of p.remoteOnlyRefused) lines.push(`refused   ${k}  not a valid key`)
      lines.push(
        `${done.filter((o) => o.verb === 'downloaded').length} downloaded, ${p.skip.length + p.replace.length} already local, ${p.remoteOnlyRefused.length} refused, ${done.filter((o) => o.failed).length} failed`,
      )
    }
    return {
      lines,
      failed: outcomes.filter((o) => o.failed).length + (command === 'upload' ? unreadable.length : 0),
    }
  })
