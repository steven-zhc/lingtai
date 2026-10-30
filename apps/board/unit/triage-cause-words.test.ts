import { CAUSE_WORDS } from '@lingtai/conductor/report'
import type { RootCause } from '@lingtai/domain/wait'
import { describe, expect, it } from 'vitest'

import { presentCause } from '../src/lib/triage-cause.ts'

describe('the report’s cause words', () => {
  it('are the board’s triage labels, lower-cased', () => {
    for (const [tag, word] of Object.entries(CAUSE_WORDS)) {
      expect(presentCause({ _tag: tag } as RootCause).label.toLowerCase()).toBe(word)
    }
  })
})
