import type { Reducer } from '@lingtai/domain'
import { describe, expect, it } from 'vitest'

import { readState } from '../src/snapshot-state.js'

const reducer: Reducer<number> = {
  name: 'count',
  version: 1,
  initial: 0,
  reduceEvent: (state) => state + 1,
  encode: (state) => String(state),
  decode: (stored) => Number(stored),
}

describe('readState', () => {
  it('rejects with the store’s own error object, not a wrapper', async () => {
    const err = new Error('the store failed')
    const store = {
      read: () => Promise.reject(err),
      readTypes: () => Promise.reject(new Error('readTypes is not reached')),
    }
    await expect(readState(store as never, reducer, 'stream', 'all')).rejects.toBe(err)
  })
})
