import { parsePayload, type SpentFor } from '@lingtai/domain'
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
 * **It never rejects.** A lost record must not refuse the dispatch, as the
 * hook's own `.catch` rules, and it is not retried. It also does not go through
 * the pass's `appendNow`, which would remember the refusal and re-raise the whole
 * pass as a defect.
 */
export async function recordPrompt(
  store: EventStore,
  stream: string,
  call: { readonly for: SpentFor; readonly promptVersion: string; readonly prompt: string },
  log: (line: string) => void = () => {},
): Promise<void> {
  try {
    const at = (await store.read(stream)).length
    await store.append(stream, at, [
      {
        type: 'RunPrompted',
        actor: 'conductor',
        data: parsePayload('RunPrompted', {
          promptVersion: call.promptVersion,
          bytes: Buffer.byteLength(call.prompt, 'utf8'),
          prompt: call.prompt,
          for: call.for,
        }),
      },
    ])
  } catch (err) {
    log(`could not record the ${call.for._tag} prompt: ${(err as Error).message}`)
  }
}
