import { z } from 'zod'

/**
 * What a recorded prompt stands in for where it did not copy a value (#927,
 * 0100 §14).
 *
 * A paid call's prompt pastes values that are already on the log or in git: the
 * ticket body the claim recorded, and a diff between two commits. Copying them
 * into every `RunPrompted` re-stores up to `runtime.budget.diff` characters per
 * review and per fix round, so the record carries the prompt with a **marker**
 * where each insert stood, and a `refs` list saying what each marker is.
 *
 * **The spans are the authority, never the text.** A body can contain the marker
 * text, a diff, or a `{{slot}}`; nothing here searches the finished string.
 * `composePrompt` knows each insert's position because it builds the prompt from
 * parts, and `expandPrompt` reads the offsets it was given.
 *
 * Pure, and no `node:` import: the board's client components import this
 * package. The hash that makes a same-size, different-content value refusable is
 * computed by the recorder and checked by the resolver, in `packages/conductor`.
 */
export const PromptRef = z.discriminatedUnion('_tag', [
  z.object({
    _tag: z.literal('TicketBody'),
    /** The ticket stream. */
    stream: z.string(),
    /** The `TicketClaimed` or `TicketContinued` at this version; its `body`. */
    version: z.number().int().nonnegative(),
  }),
  z.object({
    _tag: z.literal('Diff'),
    /** Full shas. The text is `git diff <DIFF_FLAGS> from...to`. */
    from: z.string(),
    to: z.string(),
  }),
])
export type PromptRef = z.infer<typeof PromptRef>

/** Where one marker stands in a recorded prompt, before the recorder hashes what it stands for. */
export interface PromptSpan {
  /** [start, end) — UTF-16 offsets of the marker in the recorded `prompt`. */
  readonly start: number
  readonly end: number
  readonly ref: PromptRef
  /** UTF-8 size of the value the marker stands for. */
  readonly bytes: number
}

/** A span as recorded on `RunPrompted.refs`. */
export const PromptRefEntry = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  ref: PromptRef,
  bytes: z.number().int().nonnegative(),
  /** SHA-256 (hex) of the inserted value, so a value of the same size and other content is refused. */
  sha256: z.string(),
})
export type PromptRefEntry = z.infer<typeof PromptRefEntry>

/**
 * The one spelling of a diff, for the reviewer, the fixer and the resolver: git's
 * own config would otherwise shape it (`hunksOf` strips `a/` and `b/`, which
 * `diff.noprefix` changes, and an external driver or textconv is not unified).
 */
export const DIFF_FLAGS: readonly string[] = [
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--src-prefix=a/',
  '--dst-prefix=b/',
]

export const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length

/** The text a recorded prompt holds where `ref` stood. A person can read it unexpanded. */
export function markerOf(ref: PromptRef, bytes: number): string {
  return ref._tag === 'Diff'
    ? `⟪lingtai:diff ${ref.from.slice(0, 7)}...${ref.to.slice(0, 7)} · ${bytes} bytes⟫`
    : `⟪lingtai:body ${ref.stream}@${ref.version} · ${bytes} bytes⟫`
}

export type PromptPart = string | { readonly text: string; readonly ref: PromptRef }

export interface ComposedPrompt {
  /** The prompt as handed to the runtime. Plain concatenation. */
  readonly handed: string
  /** The prompt as recorded: a marker in place of each referenced insert. */
  readonly recorded: string
  readonly refs: readonly PromptSpan[]
  /** `values[i]` is the text `refs[i]` stands for. In memory only, for the recorder to hash. */
  readonly values: readonly string[]
}

/**
 * Builds a prompt from parts, so each referenced insert's position is known by
 * construction. A referenced part with empty text is plain: nothing is saved by
 * referencing `''`, and a marker would be longer than it.
 */
export function composePrompt(parts: readonly PromptPart[]): ComposedPrompt {
  let handed = ''
  let recorded = ''
  const refs: PromptSpan[] = []
  const values: string[] = []
  for (const part of parts) {
    if (typeof part === 'string' || part.text === '') {
      const text = typeof part === 'string' ? part : part.text
      handed += text
      recorded += text
      continue
    }
    const bytes = utf8Bytes(part.text)
    const marker = markerOf(part.ref, bytes)
    refs.push({ start: recorded.length, end: recorded.length + marker.length, ref: part.ref, bytes })
    values.push(part.text)
    handed += part.text
    recorded += marker
  }
  return { handed, recorded, refs, values }
}

/** What a resolver found for one ref. */
export type PromptValue = { readonly text: string } | { readonly unresolved: string }

export interface UnresolvedRef {
  readonly index: number
  readonly ref: PromptRef | null
  readonly why: string
}

export interface ExpandedPrompt {
  /** Null for a v1 event that recorded no prompt. */
  readonly text: string | null
  readonly unresolved: readonly UnresolvedRef[]
}

/**
 * Substitutes each marker with the value it stands for and gives back exactly
 * the string that was handed, or says which reference did not resolve. Never
 * throws, and never invents text: a marker that cannot be replaced stays where it
 * is. A record with no `refs` is a whole prompt, as every event written before
 * #927 is.
 */
export function expandPrompt(
  record: {
    readonly prompt: string | null
    readonly refs?: readonly Pick<PromptRefEntry, 'start' | 'end' | 'ref' | 'bytes'>[] | undefined
  },
  values: readonly PromptValue[],
): ExpandedPrompt {
  const { prompt } = record
  const refs = record.refs ?? []
  if (prompt === null) return { text: null, unresolved: [] }
  if (refs.length === 0) return { text: prompt, unresolved: [] }

  let at = 0
  for (const [index, entry] of refs.entries()) {
    if (entry.start < at || entry.end < entry.start || entry.end > prompt.length) {
      return { text: prompt, unresolved: [{ index, ref: entry.ref, why: 'malformed refs' }] }
    }
    at = entry.end
  }

  let text = prompt
  const unresolved: UnresolvedRef[] = []
  // Last to first, so the offsets of the spans still to do stay valid.
  for (let index = refs.length - 1; index >= 0; index--) {
    const entry = refs[index]!
    const fail = (why: string) => unresolved.push({ index, ref: entry.ref, why })
    if (prompt.slice(entry.start, entry.end) !== markerOf(entry.ref, entry.bytes)) {
      fail('the record does not hold the marker it names')
      continue
    }
    const value = values[index]
    if (value === undefined) {
      fail('no value was given for this reference')
      continue
    }
    if ('unresolved' in value) {
      fail(value.unresolved)
      continue
    }
    const size = utf8Bytes(value.text)
    if (size !== entry.bytes) {
      fail(`the value is ${size} bytes, the record says ${entry.bytes}`)
      continue
    }
    text = text.slice(0, entry.start) + value.text + text.slice(entry.end)
  }
  return { text, unresolved: unresolved.sort((a, b) => a.index - b.index) }
}
