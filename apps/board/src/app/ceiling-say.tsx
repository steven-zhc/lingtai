/**
 * The spend card's sentence and the counting behind it, drawn by `/p/<project>/recipe` and the setup page's preview.
 *
 * **Its only import is React**, and the prop is a shape declared here: `setup-form.tsx` is `"use client"`, and
 * `@lingtai/conductor/ceiling` imports `@lingtai/domain`, which may not reach a client graph. The reading crosses as
 * data — `ceilingReading` and `ceilingSentences` run on the server.
 */
export interface CeilingSayProps {
  /** `A ticket gets at most 53 implement runs, 75m and 350 turns each — 3975m at most.` */
  summary: string
  /** The counting, one sentence each. */
  sentences: readonly string[]
}

export function CeilingSay({ summary, sentences }: CeilingSayProps) {
  return (
    <>
      <p className="say">{summary}</p>
      <details className="say-more">
        <summary>how this is counted</summary>
        {sentences.map((sentence) => (
          <p key={sentence}>{sentence}</p>
        ))}
      </details>
    </>
  )
}
