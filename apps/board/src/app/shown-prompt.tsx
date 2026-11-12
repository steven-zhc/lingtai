import type { ExpandedPrompt } from '@lingtai/domain'

import type { PromptShown } from '@/lib/expand-prompts'

import { Deferred, type Answered } from './deferred.tsx'
import { DocumentBody } from './markdown.tsx'
import { Skeleton } from './skeleton.tsx'

/**
 * A recorded prompt as it was handed (#933, 0111 §15): the placeholder while its
 * references resolve, then the text with each marker expanded. A marker that did
 * not expand stays where it stood, and one line under the text says why.
 *
 * Takes `Answered`, so a test passes the resolved value and sees what the page
 * sees once it has arrived.
 */
export function ShownPrompt({
  shown,
  lines,
  rawClass = 'hdoctext',
}: {
  shown: Answered<ExpandedPrompt>
  lines: number
  rawClass?: string
}) {
  return (
    <Deferred value={shown} fallback={<Skeleton shape="lines" count={lines} />}>
      {(got) => (
        <>
          {got.text === null ? null : <DocumentBody source="prompt" text={got.text} rawClass={rawClass} />}
          {got.unresolved.map((u) => (
            <p key={`${u.index}:${u.why}`} className="empty">
              This reference could not be expanded: {u.why}.
            </p>
          ))}
        </>
      )}
    </Deferred>
  )
}

export type { PromptShown }
