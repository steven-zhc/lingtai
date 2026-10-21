import { join } from 'node:path'

/**
 * Reading code out of the mirror, without a worktree.
 *
 * The mirror is bare — there is no working tree in it — so the only way to see
 * a file is `git show <ref>:<path>`, and that is a command **Lingtai** runs.
 * That distinction is the whole of
 * [0033](../../../doc/decisions-archive/0033-the-third-kind-of-agent.md) §1: an agent
 * that only reads needs no worktree, no hook and no gates, and giving it a
 * shell so it could read for itself would not extend that shape, it would make
 * it the run agent under a different name.
 *
 * Nothing here fetches or checks anything out. The mirror is Lingtai's
 * own copy and the conductor is what keeps it current; a reader that fetched
 * would be changing the thing it was asked to describe.
 *
 * **Absence is an answer, never an error.** A branch that was never pushed, a
 * path that does not exist at that ref, a project with no mirror yet — each of
 * them is a fact the caller has to state out loud, and a throw would make them
 * all read as "something went wrong". `worktree.ts` resets an attempt's branch
 * with `-B` on every run, so an attempt that committed nothing never had one;
 * that case is `#89`'s second attempt and reading `main` silently instead is
 * what killed the repair.
 */
import { stateDir } from '@lingtai/env'

import { git } from './git.ts'

/** `<home>/repos/<project>.git`. The bare clone the conductor cuts worktrees from. */
export function mirrorPathFor(project: string, home = stateDir()): string {
  return join(home, 'repos', `${project}.git`)
}

export interface MirrorOptions {
  project: string
  home?: string
}

/** The commit a ref points at, or null when the mirror has no such ref. */
export async function refSha(options: MirrorOptions & { ref: string }): Promise<string | null> {
  return git(['rev-parse', '--verify', `${options.ref}^{commit}`], {
    cwd: mirrorPathFor(options.project, options.home),
  }).catch(() => null)
}

/** Read a branch without treating a missing ref as a failed mirror read. */
export async function mirrorBranchSha(
  options: MirrorOptions & { ref: string },
): Promise<{ at: string } | { missing: true } | { unreadable: string }> {
  const cwd = mirrorPathFor(options.project, options.home)
  try {
    if ((await git(['rev-parse', '--is-bare-repository'], { cwd })) !== 'true') {
      return { unreadable: `${cwd} is not a bare git mirror` }
    }
    const sha = await git(['for-each-ref', '--format=%(objectname)', options.ref], { cwd })
    return sha === '' ? { missing: true } : { at: sha }
  } catch (error) {
    return { unreadable: (error as Error).message }
  }
}

/**
 * One file at one ref, or null.
 *
 * Bounded, because a caller is putting this in a prompt and a minified bundle
 * or a lockfile would spend the whole context on one file. Truncation is said
 * in the returned text rather than left for the reader to notice.
 */
export async function readAt(
  options: MirrorOptions & { ref: string; path: string; limitBytes?: number },
): Promise<string | null> {
  const limit = options.limitBytes ?? 64_000
  const text = await git(['show', `${options.ref}:${options.path}`], {
    cwd: mirrorPathFor(options.project, options.home),
  }).catch(() => null)
  if (text === null) return null
  return text.length > limit
    ? `${text.slice(0, limit)}\n\n[truncated at ${limit} bytes; the file is ${text.length}]`
    : text
}

/**
 * `git diff --stat <base>...<head>`, bounded the way `readAt` bounds a file.
 *
 * Three-dot, from the merge base, so a `base` that moved after the attempt's
 * run started does not show up as reverted — two-dot would diff against
 * `base`'s current tip and render every change `base` gained since as if
 * the attempt had undone it.
 *
 * Null where the mirror has no such diff — one of the two refs missing, or
 * `git` itself refusing — never thrown: a caller putting this in a prompt
 * treats absence as "no diff stat could be read", the same way `readAt`'s
 * caller does.
 */
export async function diffStatAt(
  options: MirrorOptions & { base: string; head: string; limitBytes?: number },
): Promise<string | null> {
  const limit = options.limitBytes ?? 8_000
  const text = await git(['diff', '--stat', `${options.base}...${options.head}`], {
    cwd: mirrorPathFor(options.project, options.home),
  }).catch(() => null)
  if (text === null) return null
  return text.length > limit
    ? `${text.slice(0, limit)}\n\n[truncated at ${limit} bytes; the diff stat is ${text.length}]`
    : text
}

/**
 * Every path at a ref, so a reader can name one.
 *
 * A file list rather than a search: this is the index a reader picks from, and
 * a repository large enough for that to be unreasonable is one where the list
 * is cut and said to be cut. Lingtai's own tree is about 200 files.
 */
export async function listAt(
  options: MirrorOptions & { ref: string; limit?: number },
): Promise<{ paths: string[]; truncated: boolean }> {
  const limit = options.limit ?? 1_500
  const out = await git(['ls-tree', '-r', '--name-only', options.ref], {
    cwd: mirrorPathFor(options.project, options.home),
  }).catch(() => null)
  if (out === null) return { paths: [], truncated: false }
  const paths = out.split('\n').filter((p) => p !== '')
  return { paths: paths.slice(0, limit), truncated: paths.length > limit }
}

export interface ConflictedPath {
  path: string
  /** Stage 1, 2 and 3 blob identities; absent stages stay null. */
  baseOid: string | null
  oursOid: string | null
  theirsOid: string | null
  base: string | null
  ours: string | null
  theirs: string | null
  hunks: number
  /** One-based conflict marker lines in the written tree, or line 1 when it has no readable markers. */
  hunkLines: number[]
}

/**
 * Inspect a merge by commit SHA in the bare mirror. `merge-tree --write-tree`
 * creates loose tree and blob objects there, but never moves or creates a ref.
 * Each side is bounded because the caller puts it in a triage prompt.
 */
export async function conflictedPathsAt(
  options: MirrorOptions & { baseSha: string; headSha: string; limitBytes?: number },
): Promise<ConflictedPath[]> {
  const cwd = mirrorPathFor(options.project, options.home)
  const version = await git(['--version'], { cwd })
  const match = /git version (\d+)\.(\d+)/.exec(version)
  if (!match || Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 38)) {
    throw new Error(`git merge-tree --write-tree requires git 2.38 or later; found ${version}`)
  }

  let output: string
  try {
    output = await git(['merge-tree', '--write-tree', '-z', options.baseSha, options.headSha], { cwd })
  } catch (err) {
    const failure = err as Error & { code?: number; stdout?: string }
    if (failure.code !== 1 || typeof failure.stdout !== 'string') throw err
    output = failure.stdout
  }
  const records = output.split('\0')
  const tree = records[0]?.trim()
  if (!tree || !/^[0-9a-f]{40,64}$/.test(tree)) throw new Error('git merge-tree returned no written tree')

  const stages = new Map<string, [string | null, string | null, string | null]>()
  for (const record of records.slice(1)) {
    const stage = /^(?:\d{6}) ([0-9a-f]{40,64}) ([123])\t([\s\S]+)$/.exec(record)
    if (!stage) continue
    const path = stage[3]!
    const sides: [string | null, string | null, string | null] = stages.get(path) ?? [null, null, null]
    sides[Number(stage[2]) - 1] = stage[1]!
    stages.set(path, sides)
  }

  const limit = options.limitBytes ?? 64_000
  const readBlob = async (oid: string | null): Promise<string | null> => {
    if (oid === null) return null
    const content = await git(['cat-file', '-p', oid], { cwd, trimOutput: false })
    return content.length > limit
      ? `${content.slice(0, limit)}\n\n[truncated at ${limit} bytes; the file is ${content.length}]`
      : content
  }
  const paths: ConflictedPath[] = []
  for (const [path, [baseOid, oursOid, theirsOid]] of stages) {
    const merged = await git(['show', `${tree}:${path}`], { cwd, trimOutput: false }).catch((err: unknown) => {
      const failure = err as Error & { code?: number; stderr?: string }
      if (failure.code === 128 && /fatal: path .* does not exist in /.test(failure.stderr ?? '')) return null
      throw err
    })
    const markerLines =
      merged?.split('\n').flatMap((line, index) => (line.startsWith('<<<<<<< ') ? [index + 1] : [])) ?? []
    const hunkLines = markerLines.length === 0 ? [1] : markerLines
    paths.push({
      path,
      baseOid,
      oursOid,
      theirsOid,
      base: await readBlob(baseOid),
      ours: await readBlob(oursOid),
      theirs: await readBlob(theirsOid),
      hunks: hunkLines.length,
      hunkLines,
    })
  }
  return paths
}
