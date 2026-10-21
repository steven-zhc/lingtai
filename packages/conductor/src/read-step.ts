/**
 * The read half of Discussion's protocol — `{"read": [...]}`, the file index
 * and the files-served renderers, and the JSON-candidate search `parseReply`
 * uses — moved out of `discuss.ts` so a second reader of the mirror can ask
 * for files the same way without compiling a runtime (`#412`).
 *
 * **Imports nothing.** `discuss.ts` imports `./tell.ts` and `./attempts.ts`;
 * this file imports neither, nor anything else, so `discuss.ts` and
 * `triage.ts` can both import it back with no runtime riding along.
 *
 * `discuss.ts` re-exports every name below that it exported before the move —
 * `apps/board/src/lib/recipe.ts` and `discuss.test.ts` both import from
 * `@lingtai/conductor/discuss`, and `buildBrief`'s output must stay
 * byte-identical.
 */

/** Files one turn may ask for. Enough to follow a call site into its callee. */
export const READS_PER_TURN = 6

/**
 * How many times one question may ask for files before it has to answer.
 *
 * Not a spend limit: it is what stops a question that cannot be answered from
 * being asked forever by a machine while the person who asked it watches a
 * spinner. When it runs out the assistant answers with what it has, and says
 * so.
 */
export const MAX_READ_ROUNDS = 4

/** A ref the assistant may name a path at, and what is in it. */
export interface ReadableRef {
  /** The name the assistant uses: `main`, or `attempt-2`. */
  ref: string
  /** What it resolves to in the mirror. The name is for reading; this is the fact. */
  sha: string
  paths: readonly string[]
  truncated: boolean
}

/** The `{"read": [...]}` half of the reply contract, quoted into a brief verbatim. */
export const READ_CONTRACT = `To ask for files — up to ${READS_PER_TURN}, each \`<ref>:<path>\` using a ref and a path
from the index above:

{"read":["main:packages/agent/src/claude-code.ts"]}`

/** The file index, one heading per ref, the paths under it. */
export function renderIndex(refs: readonly ReadableRef[]): string {
  return refs
    .map((r) => `### ${r.ref}\n\n${r.paths.join('\n')}${r.truncated ? '\n[index truncated]' : ''}`)
    .join('\n\n')
}

/** The files served so far, one heading per `<ref>:<path>`, empty string when none have been. */
export function renderServed(served: readonly { at: string; text: string | null }[]): string {
  if (served.length === 0) return ''
  return `## Files you asked for\n\n${served
    .map((f) =>
      f.text === null
        ? `### ${f.at}\n\nThere is no such path at that ref.`
        : `### ${f.at}\n\n\`\`\`\n${f.text}\n\`\`\``,
    )
    .join('\n\n')}\n`
}

/**
 * Every JSON candidate worth trying, in the order `parseReply` and
 * `parseTriage` try them: a fenced block first, then everything from the
 * first `{` on, then the whole text — because the object is what a reply
 * *ends* in, and the first brace in the text is the prose's whenever the
 * model quoted anything.
 */
export function jsonCandidates(text: string): string[] {
  const out: string[] = []
  for (const block of text.match(/```(?:json)?\s*([\s\S]*?)```/g) ?? []) {
    out.push(block.replace(/```(?:json)?/g, '').replace(/```/g, ''))
  }
  const brace = text.indexOf('{')
  if (brace >= 0) out.push(text.slice(brace))
  out.push(text)
  return out
}

/** What `v['read']` alone says, decided from one already-parsed candidate. */
export type ReadCheck = { kind: 'read'; paths: string[] } | { kind: 'skip' } | { kind: 'none' }

/**
 * `v['read']` alone, so a caller trying the read shape and another shape
 * against the *same* candidate — `parseReply`'s read-then-answer order,
 * candidate by candidate — can ask the question one candidate at a time
 * rather than across every candidate at once.
 */
export function readOf(v: Record<string, unknown>): ReadCheck {
  if (!Array.isArray(v['read'])) return { kind: 'none' }
  const paths = v['read']
    .map((p) => String(p))
    .filter((p) => p.includes(':'))
    .slice(0, READS_PER_TURN)
  // An empty or unusable `read` is not a request for nothing — it is a turn
  // that said neither shape, and the caller tries the next candidate.
  return paths.length > 0 ? { kind: 'read', paths } : { kind: 'skip' }
}
