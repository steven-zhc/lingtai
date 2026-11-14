/**
 * The sandbox state of every registered project, read from the log once per render (#1163).
 *
 * **Never asks the host.** `hostHere` loads srt, and `checkSandboxBlock` asks the host only of an enabled, required
 * block, so resolving a recipe on render could never say *degraded* anyway. The three facts are the project's
 * standing refusal (the `prj-` fold `readRegistered` already did), the recipe it last recorded (`rcp-<hash>`) and
 * the latest `SandboxBoundaryRecorded` on its newest pass's stream.
 *
 * "One read, not one per project" is as far as the store allows: it has no read across streams by type, so inside
 * the one `cache()`d read there is a `readTypes` per registered project for its recipe and one for its newest
 * pass, run together. A cross-stream type read is the change that would remove them. A project whose facts fail
 * to read is `unknown`, never *sandboxed*.
 */
import { attemptStream, recipeStream } from '@lingtai/domain'
import { eventStore } from '@lingtai/event-store'
import { readTasks } from '@lingtai/projector'
import { Context, Effect } from 'effect'
import { cache } from 'react'

import { readRegistered } from './locks.ts'
import {
  sandboxState,
  worstOf,
  type BoundaryFact,
  type SandboxFacts,
  type SandboxMark,
  type SandboxState,
} from './sandbox-state.ts'

const run = Effect.runPromiseWith(Context.empty())

const UNKNOWN: SandboxState = sandboxState({ refused: null, block: null, boundary: null })

/** The recorded recipe's `sandbox` block: `undefined` for none, `null` when no recipe was recorded. */
const blockOf = (hash: string | null) =>
  hash === null
    ? Effect.succeed(null)
    : Effect.tryPromise(() => eventStore.readTypes(recipeStream(hash), ['RecipeRecorded'])).pipe(
        Effect.map((events) => {
          const last = events.at(-1)
          if (last === undefined) return null
          const recipe = (last.data as { recipe: Record<string, unknown> }).recipe
          const block = recipe.sandbox
          return block === undefined || block === null ? undefined : (block as { enabled?: unknown })
        }),
      )

/** The latest boundary on a pass's stream, `null` when it has none. */
const boundaryOf = (runId: string | null) =>
  runId === null
    ? Effect.succeed(null)
    : Effect.tryPromise(() =>
        eventStore.readTypes(runId.startsWith('pass-') ? runId : attemptStream(runId), ['SandboxBoundaryRecorded']),
      ).pipe(
        Effect.map((events): BoundaryFact | null => {
          const last = events.at(-1)
          return last === undefined ? null : ((last.data as { boundary: BoundaryFact }).boundary ?? null)
        }),
      )

const readAll = Effect.gen(function* () {
  const projects = yield* Effect.tryPromise(() => readRegistered())
  // A board that cannot be read leaves every boundary unknown; the refusal and the recipe still say.
  const cards = yield* Effect.tryPromise(() => readTasks()).pipe(Effect.catch(() => Effect.succeed([])))
  // The newest pass per project: the card whose last attempt is latest.
  const newest = new Map<string, { runId: string; at: number }>()
  for (const card of cards) {
    if (card.runId === null) continue
    const at = (card.lastAttemptAt ?? card.updatedAt).getTime()
    const held = newest.get(card.project)
    if (held === undefined || at > held.at) newest.set(card.project, { runId: card.runId, at })
  }
  const states = new Map<string, SandboxState>()
  yield* Effect.forEach(
    projects,
    (p) =>
      Effect.gen(function* () {
        if (p.project === null) return
        const [block, boundary] = yield* Effect.all(
          [blockOf(p.configHash), boundaryOf(newest.get(p.project)?.runId ?? null)],
          { concurrency: 2 },
        )
        const facts: SandboxFacts = { refused: p.refused?.detail ?? null, block, boundary }
        states.set(p.project, sandboxState(facts))
      }).pipe(Effect.catch(() => Effect.sync(() => void states.set(p.project ?? '', UNKNOWN)))),
    { concurrency: 8 },
  )
  states.delete('')
  return states as ReadonlyMap<string, SandboxState>
})

/** Every registered project's state, read once however many places of one render ask. Empty when it cannot be read. */
export const readSandboxStates = cache((): Promise<ReadonlyMap<string, SandboxState>> =>
  run(readAll).catch(() => new Map<string, SandboxState>()),
)

/**
 * What the bar draws: the selected project's state when one is in view and registered, otherwise the worst across
 * every project. Undefined draws nothing — no project registered, or a read that said nothing.
 */
export function readSandboxMark(project?: string): Promise<SandboxMark | undefined> {
  return readSandboxStates().then((states) => {
    const one = project === undefined ? undefined : states.get(project)
    return worstOf(project !== undefined && one !== undefined ? new Map([[project, one]]) : states)
  })
}
