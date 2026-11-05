import { createHash } from 'node:crypto'

import { DIFF_FLAGS, utf8Bytes, type PromptRef, type PromptRefEntry, type PromptValue } from '@lingtai/domain'
import type { EventStore } from '@lingtai/event-store'

import { valueOfStep } from './step-value.ts'

/**
 * Turns the `refs` of a recorded `RunPrompted` back into the values they stand
 * for, for `expandPrompt` (#927, 0100 §14).
 *
 * **Impure, and injected**: a store to read a body from and a git runner for a
 * diff. It runs a read-only `git diff` in the project's mirror, which takes no
 * lock, and never fetches: a commit the mirror does not hold is `unresolved`, not
 * a reason to go to the network. Nothing here reads an environment variable, so a
 * ref can never carry a secret.
 *
 * **It never throws and never invents text.** A read that fails, an event that is
 * not there or holds no `body`, a diff that git cannot produce, a value whose size
 * or `sha256` is not the one recorded — each is that entry's `unresolved`, with a
 * reason. The size and the hash are checked here as well as in
 * `expandPrompt`, which checks both itself, so a mismatch is reported per entry.
 */
export interface PromptRefPorts {
  readonly store: Pick<EventStore, 'read'>
  /** `git <args>` with `cwd` as the working directory. A failure is `ok: false` with git's words. */
  readonly git: (
    args: readonly string[],
    cwd: string,
  ) => Promise<{ ok: true; out: string } | { ok: false; why: string }>
  /** The project's mirror, `mirrorPathFor(project)`. */
  readonly mirrorPath: string
}

const sha256Of = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/** Only these two carry a body (`claim.ts`). */
const CLAIM_TYPES: ReadonlySet<string> = new Set(['TicketClaimed', 'TicketContinued'])
const isClaim = (type: string): boolean => CLAIM_TYPES.has(type)

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

type Fetched = { readonly text: string } | { readonly unresolved: string }

function fetchBody(ref: Extract<PromptRef, { _tag: 'TicketBody' }>, ports: PromptRefPorts): Promise<Fetched> {
  return ports.store.read(ref.stream).then((events): Fetched => {
    const at = events.find((event) => event.version === ref.version)
    if (at === undefined) return { unresolved: `${ref.stream} has no event at version ${ref.version}` }
    const body = isClaim(at.type) ? (at.data as { body?: unknown }).body : undefined
    if (!isClaim(at.type))
      return { unresolved: `the event at ${ref.stream}@${ref.version} is a ${at.type}, not a claim` }
    return typeof body === 'string'
      ? { text: body }
      : { unresolved: `the ${at.type} at ${ref.stream}@${ref.version} holds no body` }
  })
}

function fetchDiff(ref: Extract<PromptRef, { _tag: 'Diff' }>, ports: PromptRefPorts): Promise<Fetched> {
  const has = (sha: string) => ports.git(['cat-file', '-e', `${sha}^{commit}`], ports.mirrorPath)
  return Promise.all([has(ref.from), has(ref.to)]).then(([from, to]) => {
    if (!from.ok) return { unresolved: `${ref.from} is not in the mirror` }
    if (!to.ok) return { unresolved: `${ref.to} is not in the mirror` }
    return ports
      .git(['diff', ...DIFF_FLAGS, `${ref.from}...${ref.to}`], ports.mirrorPath)
      .then((got): Fetched => (got.ok ? { text: got.out } : { unresolved: `git diff failed: ${got.why}` }))
  })
}

function fetchStepValue(ref: Extract<PromptRef, { _tag: 'StepValue' }>, ports: PromptRefPorts): Promise<Fetched> {
  return ports.store.read(ref.stream).then((events): Fetched => {
    const at = events.find((event) => event.version === ref.version)
    if (at === undefined) return { unresolved: `${ref.stream} has no event at version ${ref.version}` }
    if (at.type !== 'StepEnded')
      return { unresolved: `the event at ${ref.stream}@${ref.version} is a ${at.type}, not a StepEnded` }
    const found = valueOfStep(at.data, ref.action, ref.field)
    if (found === undefined)
      return { unresolved: `the StepEnded at ${ref.stream}@${ref.version} holds no ${ref.field} for ${ref.action}` }
    return { text: ref.trimmed === true ? found.trim() : found }
  })
}

function resolveOne(
  entry: Pick<PromptRefEntry, 'ref' | 'bytes' | 'sha256'>,
  ports: PromptRefPorts,
): Promise<PromptValue> {
  const { ref } = entry
  // Inside a `.then`, so a port that throws before it returns a promise is caught too.
  return Promise.resolve()
    .then(() => {
      switch (ref._tag) {
        case 'TicketBody':
          return fetchBody(ref, ports)
        case 'Diff':
          return fetchDiff(ref, ports)
        case 'StepValue':
          return fetchStepValue(ref, ports)
        default: {
          const never: never = ref
          return never
        }
      }
    })
    .then((got): PromptValue => {
      if ('unresolved' in got) return got
      const size = utf8Bytes(got.text)
      if (size !== entry.bytes) {
        return {
          unresolved: `${ref._tag === 'Diff' ? 'git produced' : 'the event holds'} ${size} bytes, the record says ${entry.bytes}`,
        }
      }
      return sha256Of(got.text) === entry.sha256
        ? { text: got.text }
        : { unresolved: "the value's sha256 differs from the record's" }
    })
}

export function resolvePromptRefs(
  entries: readonly Pick<PromptRefEntry, 'ref' | 'bytes' | 'sha256'>[],
  ports: PromptRefPorts,
): Promise<PromptValue[]> {
  return Promise.all(
    entries.map((entry) => resolveOne(entry, ports).catch((err: unknown) => ({ unresolved: messageOf(err) }))),
  )
}
