/**
 * #510: an approved item is not a pass in flight. `WaitResolved{Approve}`
 * used to fold to `state: 'running'` in `task_view`
 * (`@lingtai/projector/task-view`), the same state a live claim folds to, so
 * `inFlight()` read an approval nothing was holding as a conductor still
 * working it — the drain banner, `lingtai doctor` and the board's draining
 * chip all say so from this one function. `state: 'approved'` is its own
 * `LabelState` now, and `held` is what `inFlight()` reduces to once a
 * database read hands it rows.
 */
import { describe, expect, it } from 'vitest'

import { held } from '../src/control.ts'

describe('held names only a pass a conductor is actually holding', () => {
  it('counts a claimed, running row', () => {
    expect(held([{ project: 'lingtai', issue: '510', state: 'running' }])).toEqual(['lingtai#510'])
  })

  it('counts a verifying row — the agent exited but the steps are not done', () => {
    expect(held([{ project: 'lingtai', issue: '511', state: 'verifying' }])).toEqual(['lingtai#511'])
  })

  it('excludes an approved row with no claim on it', () => {
    expect(held([{ project: 'lingtai', issue: '512', state: 'approved' }])).toEqual([])
  })

  it('excludes queued, waiting, landed and closed rows alongside a running one', () => {
    expect(
      held([
        { project: 'lingtai', issue: '1', state: 'queued' },
        { project: 'lingtai', issue: '2', state: 'waiting' },
        { project: 'lingtai', issue: '3', state: 'landed' },
        { project: 'lingtai', issue: '4', state: 'closed' },
        { project: 'lingtai', issue: '5', state: 'running' },
      ]),
    ).toEqual(['lingtai#5'])
  })
})
