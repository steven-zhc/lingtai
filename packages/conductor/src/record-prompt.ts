import { createHash } from 'node:crypto'

import { composePrompt, parsePayload, utf8Bytes, type ComposedPrompt, type SpentFor } from '@lingtai/domain'
import type { EventStore } from '@lingtai/event-store'

/**
 * The prompt a paid agent call was handed, on the log (#923).
 *
 * The hook records the implementer's (`hook-socket.ts`, #88); every other paid
 * call runs unhooked, and its prompt was recorded nowhere. This is the second
 * writer of `RunPrompted`: it carries the same `for` the call's `RunSpent` will,
 * so a reader finds the prompt beside its cost, and the attempt reducer leaves
 * the attempt's own `prompt` alone for an event that has one.
 *
 * **A prompt is a string or a composed prompt** (#927). A string is recorded
 * whole. A `ComposedPrompt` is recorded as its marked form with a `refs` entry per
 * marker — each carrying the `sha256` of the value it stands for, which the
 * domain cannot compute — while `bytes` stays the size of the prompt as handed.
 * Nothing is written to `refs` when nothing was referenced, so such an event is
 * the one written before this existed.
 *
 * **It never rejects.** A lost record must not refuse the dispatch, as the
 * hook's own `.catch` rules, and it is not retried. It also does not go through
 * the pass's `appendNow`, which would remember the refusal and re-raise the whole
 * pass as a defect.
 */
export function recordPrompt(
  store: EventStore,
  stream: string,
  call: { readonly for: SpentFor; readonly promptVersion: string; readonly prompt: string | ComposedPrompt },
  log: (line: string) => void = () => {},
): Promise<void> {
  return Promise.resolve()
    .then(() => {
      const composed = typeof call.prompt === 'string' ? composePrompt([call.prompt]) : call.prompt
      const refs = composed.refs.map((span, index) => ({
        ...span,
        sha256: createHash('sha256')
          .update(composed.values[index] ?? '', 'utf8')
          .digest('hex'),
      }))
      return { composed, refs }
    })
    .then(({ composed, refs }) =>
      store.read(stream).then((have) =>
        store.append(stream, have.length, [
          {
            type: 'RunPrompted',
            actor: 'conductor',
            data: parsePayload('RunPrompted', {
              promptVersion: call.promptVersion,
              bytes: utf8Bytes(composed.handed),
              prompt: composed.recorded,
              for: call.for,
              ...(refs.length === 0 ? {} : { refs }),
            }),
          },
        ]),
      ),
    )
    .then(
      () => undefined,
      (err: unknown) => {
        log(`could not record the ${call.for._tag} prompt: ${err instanceof Error ? err.message : String(err)}`)
      },
    )
}
