/**
 * `holdDiscussionEffect` run from a test whose fake ports are promises.
 *
 * The ports are Effects now; a fake written as an `async` function is lifted here, so a rejection
 * arrives as a failure. A fake that dies is written as an Effect and handed to `holdDiscussionEffect`.
 */
import { Effect } from 'effect'

import {
  holdDiscussionEffect,
  type Answered,
  type DiscussionPorts,
  type DiscussionTurnOptions,
  type HeldTurn,
} from '../src/discuss.ts'

export type PromisePorts = Omit<DiscussionPorts, 'serve' | 'ask' | 'version'> & {
  serve(ref: string, path: string): Promise<string | null>
  ask(prompt: string, round: number, call: { model?: string; turns: number; wallMs: number }): Promise<Answered>
  version(): Promise<string | null>
}

export const hold = (ports: PromisePorts, options: DiscussionTurnOptions): Promise<HeldTurn> =>
  Effect.runPromise(
    holdDiscussionEffect(
      {
        ...ports,
        serve: (ref, path) => Effect.tryPromise(() => ports.serve(ref, path)),
        ask: (prompt, round, call) => Effect.tryPromise(() => ports.ask(prompt, round, call)),
        version: () => Effect.tryPromise(() => ports.version()),
      },
      options,
    ),
  )
