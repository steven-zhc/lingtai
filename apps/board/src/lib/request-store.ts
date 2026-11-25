/**
 * The event store as one board request sees it (#1420): each stream is read at most once, however many readers of the
 * page ask — the project's `prj`, each `pr-<project>-<n>`, the accounts.
 *
 * **Why the store and not each reader.** The reads that repeat happen inside `@lingtai/project` and
 * `@lingtai/conductor` (`listPrs`, `openPr`, `readDraft`, `loadProject`), each through the `store` it was handed, so
 * only a store handed to them can share them. `cache()` is what scopes it to one request: a module-level instance would
 * be a `Map` across requests and would serve a stale recipe or PR to the next page, breaking *the board follows the log*.
 *
 * - What is kept is the **promise**, so two callers asking at once share one in-flight read, and a read that rejected
 *   stays a rejection for the rest of the request — never an empty value.
 * - An append, successful or not, drops what was kept for every stream it named: `recordObservedRecipe` appends from a
 *   render and retries on a lost race, and a kept read would hand the retry the same stale version.
 *
 * **Pages and their loaders read through `requestStore()`. A server action never does**: it reads, appends and reads
 * again, and `cache()` scopes to an action's request too, so a kept read would serve the state from before its own append.
 */
import { eventStore } from '@lingtai/event-store'
import type { EventStore } from '@lingtai/event-store/store'
import { cache } from 'react'

/** `store` with `read` and `head` kept by what they were asked; every other method passes through. */
export function memoStore(store: EventStore): EventStore {
  const reads = new Map<string, Promise<unknown>>()
  const heads = new Map<string, Promise<number>>()
  const forget = (streams: readonly string[]): void => {
    for (const id of streams) {
      for (const key of [...reads.keys()]) if (key.startsWith(`${id}\0`)) reads.delete(key)
      heads.delete(id)
    }
  }
  const dropping = async <T>(streams: readonly string[], run: () => Promise<T>): Promise<T> => {
    try {
      return await run()
    } finally {
      forget(streams)
    }
  }
  return {
    append: (streamId, expectedVersion, events) =>
      dropping([streamId], () => store.append(streamId, expectedVersion, events)),
    appendAll: (batches) =>
      dropping(
        batches.map((b) => b.streamId),
        () => store.appendAll(batches),
      ),
    read: (streamId, fromVersion) => {
      const key = `${streamId}\0${fromVersion ?? 1}`
      let kept = reads.get(key)
      if (kept === undefined) {
        kept = store.read(streamId, fromVersion)
        reads.set(key, kept)
      }
      return kept as ReturnType<EventStore['read']>
    },
    head: (streamId) => {
      let kept = heads.get(streamId)
      if (kept === undefined) {
        kept = store.head(streamId)
        heads.set(streamId, kept)
      }
      return kept
    },
    readTypes: (streamId, types, fromVersion) => store.readTypes(streamId, types, fromVersion),
    readAll: (fromSeq, limit) => store.readAll(fromSeq, limit),
  }
}

/**
 * The store of this request. **A reader added later goes through this one**, not `eventStore`, in a page or a loader;
 * never in a server action (see the file's header).
 */
export const requestStore = cache((): EventStore => memoStore(eventStore))
