/**
 * `lingtai account lift <account>` (#1008, 0126 §7): a person says an account's
 * limit is over. An Effect over a store and a `log`, so the suite drives
 * it against a memory store and reads the appends back.
 */
import { liftAccountLimit } from '@lingtai/conductor'
import { Account, accountWords } from '@lingtai/domain'
import { type EventStore, eventStore } from '@lingtai/event-store'
import { Effect } from 'effect'

import type { Outcome } from './project-pause.ts'

export interface AccountLiftOptions {
  /** The suite passes a memory store and a collector; nothing else should set them. */
  store?: EventStore
  log?: (line: string) => void
}

const ACCOUNTS = Account.options.join(', ')

export const liftAccount = (account: string | undefined, by: string, options: AccountLiftOptions = {}) =>
  Effect.gen(function* () {
    const log = options.log ?? console.log
    const parsed = Account.safeParse(account)
    if (!parsed.success) {
      log(
        account === undefined
          ? `no account named — accounts: ${ACCOUNTS}`
          : `unknown account "${account}" — accounts: ${ACCOUNTS}`,
      )
      return 2 as Outcome
    }
    const { limit } = accountWords(parsed.data)
    const answer = yield* liftAccountLimit(options.store ?? eventStore, parsed.data, by).pipe(
      Effect.mapError((e) => new Error(`could not lift ${parsed.data}'s ${limit} — ${e.message}`)),
    )
    if (answer.kind === 'not-limited') {
      log(`${parsed.data} is not at its ${limit} — nothing to lift`)
    } else {
      log(`${parsed.data}'s ${limit} lifted by ${by} — projects that use it take work again at the next look`)
    }
    return 0 as Outcome
  })
