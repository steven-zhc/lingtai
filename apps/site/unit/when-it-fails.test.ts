import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { BOUNDS, TRIAGE_SPLIT_CHILDREN_MAX } from '@lingtai/domain'
import { describe, expect, it } from 'vitest'

const page = readFile(path.resolve(__dirname, '../../../doc/when-it-fails.md'), 'utf8')

describe('doc/when-it-fails.md', () => {
  it('states the numbers the code holds', async () => {
    const text = await page
    const row = (start: string) => text.split('\n').find((l) => l.startsWith(`| ${start}`)) ?? ''
    expect(row('The API is down')).toContain(`${BOUNDS.stepRedos} tries`)
    expect(row('The ticket is unclear')).toContain(`${BOUNDS.personAsks} stops`)
    expect(row('The ticket is too big')).toContain(`at most ${TRIAGE_SPLIT_CHILDREN_MAX} parts`)
    expect(row('Someone else changed main')).toContain(`${BOUNDS.baseBranchMerges} merges`)
    expect(row('Origin refused')).toContain(`${BOUNDS.landingRetries} times`)
  })
})
