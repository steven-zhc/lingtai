import { createHash } from 'node:crypto'

import {
  composePrompt,
  parsePayload,
  utf8Bytes,
  type ComposedPrompt,
  type Envelope,
  type PromptPart,
  type SpentFor,
} from '@lingtai/domain'
import type { EventStore } from '@lingtai/event-store'

import { stepValues } from './step-value.ts'

/**
 * An insert that is a value some `StepEnded` on this run's stream holds (#928).
 * The caller says what it inserted and never where it came from: `recordPrompt`
 * looks, in the read it already makes, and writes the text out when it finds
 * nothing.
 */
export interface StepPart {
  readonly text: string
  readonly onStep: { readonly field: 'evidence' | 'document'; readonly trimmed: boolean }
}
export type RecordPart = PromptPart | StepPart

const isStepPart = (part: RecordPart): part is StepPart => typeof part !== 'string' && 'onStep' in part

/** The latest `StepEnded` whose action holds exactly `part.text`, as a referenced part; the text itself if none does. */
function withStepRef(part: StepPart, stream: string, have: readonly Envelope[]): PromptPart {
  if (part.text === '') return part.text
  for (let i = have.length - 1; i >= 0; i--) {
    const event = have[i]!
    if (event.type !== 'StepEnded') continue
    for (const { action, value } of stepValues(event.data, part.onStep.field)) {
      if ((part.onStep.trimmed ? value.trim() : value) !== part.text) continue
      return {
        text: part.text,
        ref: {
          _tag: 'StepValue',
          stream,
          version: event.version,
          action,
          field: part.onStep.field,
          ...(part.onStep.trimmed ? { trimmed: true as const } : {}),
        },
      }
    }
  }
  return part.text
}

/**
 * The prompt a paid agent call was handed, on the log (#923).
 *
 * The one writer of `RunPrompted` (0100 §14). The hook used to record the
 * implementer's (#88); since #928 the conductor does, before it dispatches, and
 * the hook appends nothing. Every record carries the same `for` the call's
 * `RunSpent` will, so a reader finds the prompt beside its cost, and the attempt
 * reducer takes the implement round-0 record (or one with no `for`, written
 * before this) as the attempt's own `prompt` and leaves the others alone.
 *
 * **Awaited before `server.register`** for the implementer: the hook server reads
 * the stream's length there for its expected version, and a record appended after
 * it would make the hook's next append a `ConcurrencyError`.
 *
 * **A prompt is a string, a composed prompt or parts** (#927, #928). A string is
 * recorded whole. Parts may include a `StepPart`, which becomes a `StepValue`
 * reference if this stream holds a `StepEnded` carrying that exact text. A `ComposedPrompt` is recorded as its marked form with a `refs` entry per
 * marker — each carrying the `sha256` of the value it stands for, computed here
 * with `node:crypto` — while `bytes` stays the size of the prompt as handed.
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
  call: {
    readonly for: SpentFor
    readonly promptVersion: string
    readonly prompt: string | ComposedPrompt | readonly RecordPart[]
  },
  log: (line: string) => void = () => {},
): Promise<void> {
  return Promise.resolve()
    .then(() =>
      store.read(stream).then((have) => {
        const composed =
          typeof call.prompt === 'string'
            ? composePrompt([call.prompt])
            : Array.isArray(call.prompt)
              ? composePrompt(
                  (call.prompt as readonly RecordPart[]).map((part) =>
                    isStepPart(part) ? withStepRef(part, stream, have) : part,
                  ),
                )
              : (call.prompt as ComposedPrompt)
        const refs = composed.refs.map((span, index) => ({
          ...span,
          sha256: createHash('sha256')
            .update(composed.values[index] ?? '', 'utf8')
            .digest('hex'),
        }))
        return store.append(stream, have.length, [
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
        ])
      }),
    )
    .then(
      () => undefined,
      (err: unknown) => {
        log(`could not record the ${call.for._tag} prompt: ${err instanceof Error ? err.message : String(err)}`)
      },
    )
}
