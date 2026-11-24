import { prStream } from '@lingtai/domain'
/**
 * A test's Submit: puts one ticket in the draft first when no PR is open and no draft exists, because nothing yet writes
 * `PrDraftTicketAdded` outside a test (ADR 0131 §2) and `requestPrSubmit` refuses `nothing-landed` without one.
 */
import type { EventStore } from '@lingtai/event-store/store'
import { Effect } from 'effect'

import { draftTarget, openPr, requestPrSubmit } from '../src/pr.ts'

export const submitPr = (project: string, mode: 'solo' | 'team', by: string, store: EventStore) =>
  Effect.gen(function* () {
    const open = yield* openPr(project, store)
    const target = yield* draftTarget(project, store)
    if (mode === 'team' && open === null && target.state === null) {
      yield* Effect.promise(() =>
        store.append(prStream(project, target.n), 0, [
          { type: 'PrDraftTicketAdded', actor: 'conductor', data: { ticket: 'seed', mergeCommit: 'c0', from: null } },
        ]),
      )
    }
    return yield* requestPrSubmit(project, mode, by, store)
  })
