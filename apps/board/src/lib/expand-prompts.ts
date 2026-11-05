/**
 * A recorded prompt, shown as it was handed (#933, 0111 §15, 0100 §14).
 *
 * **Server-only.** It runs `git` and reads the mirror, so no `"use client"` file
 * may reach it — `unit/client-graph.test.ts` walks the import graph for exactly
 * that, because only the Next build sees it otherwise, after the merge (#230).
 *
 * This module builds two ports and calls the conductor's `resolvePromptRefs` and
 * the domain's `expandPrompt`. It does not fetch, hash or diff by itself: the
 * flags and the checks are decided in those two places.
 */
import { resolvePromptRefs } from '@lingtai/conductor'
import { expandPrompt, utf8Bytes, type Envelope, type ExpandedPrompt, type PromptRefEntry } from '@lingtai/domain'
import { git as repoGit, mirrorPathFor } from '@lingtai/repo'

/** What a `RunPrompted` carries that expansion needs. */
export interface RecordedPrompt {
  readonly prompt: string | null
  readonly refs?: readonly PromptRefEntry[] | null | undefined
}

/** A prompt's expansion, and how tall its placeholder is while it resolves. */
export interface PromptShown {
  /** Skeleton lines, from the size of the prompt as handed. */
  readonly lines: number
  /** A promise that never rejects. */
  readonly shown: Promise<ExpandedPrompt>
}

type GitResult = { ok: true; out: string } | { ok: false; why: string }
/** Runs `git <args>` in `cwd` and resolves with its stdout, trimmed as `packages/repo`'s `git` trims by default. */
export type RunGit = (args: readonly string[], cwd: string) => Promise<string>

/**
 * `packages/repo`'s `git` with **no** `trimOutput`, token or env: the conductor
 * recorded the hash of what that call returned (`conduct.ts`), trimmed, so a path
 * that trimmed differently would fail every hash.
 */
const defaultRun: RunGit = (args, cwd) => repoGit([...args], { cwd })

const MEMO_LIMIT = 64
/**
 * Successes only, as promises, keyed by the whole argv. A commit's presence and
 * a diff between two full shas never change, and the page re-renders on every
 * append (`live.tsx`), so without this a running attempt would re-run every diff
 * each time. A failure is dropped: the daemon's next fetch may bring the sha.
 * Process-local; a restart empties it and loses nothing.
 */
const memo = new Map<string, Promise<GitResult>>()

/** For tests. */
export function resetGitMemo(): void {
  memo.clear()
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function memoisedGit(run: RunGit): (args: readonly string[], cwd: string) => Promise<GitResult> {
  return (args, cwd) => {
    const key = `${cwd}\0${args.join('\0')}`
    const held = memo.get(key)
    if (held !== undefined) return held
    const pending: Promise<GitResult> = Promise.resolve()
      .then(() => run(args, cwd))
      .then(
        (out): GitResult => ({ ok: true, out }),
        (err: unknown): GitResult => ({ ok: false, why: messageOf(err) }),
      )
    memo.set(key, pending)
    void pending.then((got) => {
      if (!got.ok) {
        if (memo.get(key) === pending) memo.delete(key)
      }
    })
    while (memo.size > MEMO_LIMIT) memo.delete(memo.keys().next().value as string)
    return pending
  }
}

/** The size of the prompt as handed: the record's text, less each marker, plus each value. */
export function handedBytes(record: RecordedPrompt): number {
  const text = record.prompt ?? ''
  const refs = record.refs ?? []
  return refs.reduce((n, r) => n - (r.end - r.start) + r.bytes, utf8Bytes(text))
}

/** About 80 bytes to a line, between 3 and 40. */
export const skeletonLines = (bytes: number): number => Math.min(40, Math.max(3, Math.ceil(bytes / 80)))

/**
 * Resolves and expands one record. **Never rejects**: a throw from anywhere is
 * that prompt's `unresolved`, with the text as recorded.
 */
export function expandRecorded(
  record: RecordedPrompt,
  context: {
    project: string
    /** Every stream the tab holds, by id: the ticket's and each claim's run. */
    streams: ReadonlyMap<string, readonly Envelope[]>
    run?: RunGit
  },
): Promise<ExpandedPrompt> {
  const refs = record.refs ?? []
  const asRecorded = (why: string): ExpandedPrompt => ({
    text: record.prompt,
    unresolved: [{ index: -1, ref: null, why }],
  })
  return Promise.resolve()
    .then(() =>
      resolvePromptRefs(refs, {
        store: {
          read: (stream: string) => {
            const held = context.streams.get(stream)
            return held === undefined
              ? Promise.reject(new Error("not on this ticket's streams"))
              : Promise.resolve([...held])
          },
        },
        git: memoisedGit(context.run ?? defaultRun),
        mirrorPath: mirrorPathFor(context.project),
      }),
    )
    .then((values) => expandPrompt({ prompt: record.prompt, refs }, values))
    .catch((err: unknown) => asRecorded(messageOf(err)))
}

/** A record with refs gets a promise and a placeholder height; one without gets nothing, and is drawn as it always was. */
export function shownOf(record: RecordedPrompt, context: Parameters<typeof expandRecorded>[1]): PromptShown | null {
  if ((record.refs ?? []).length === 0 || record.prompt === null) return null
  return { lines: skeletonLines(handedBytes(record)), shown: expandRecorded(record, context) }
}
