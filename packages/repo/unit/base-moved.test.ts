/**
 * **Which files make a moved base worth another build and review** (#593).
 *
 * The git half of the lane (`merge-base`, the two `diff --name-only -z`) needs the
 * `git` binary and so is integration (0060 §1); this is the rule it feeds, which
 * is pure.
 */
import { describe, expect, it } from 'vitest'

import { baseMovedOn } from '../src/integrate.ts'

describe('baseMovedOn', () => {
  it('names the files both the branch and the base changed, sorted', () => {
    expect(baseMovedOn(['b.ts', 'a.ts', 'only-ours.ts'], ['a.ts', 'c.ts', 'b.ts'])).toEqual(['a.ts', 'b.ts'])
  })

  it('is empty when the base moved on other files only', () => {
    expect(baseMovedOn(['a.ts'], ['b.ts', 'c.ts'])).toEqual([])
  })

  it('is empty when the base did not move', () => {
    expect(baseMovedOn(['a.ts', 'b.ts'], [])).toEqual([])
  })

  it('names a file once however often either side lists it', () => {
    expect(baseMovedOn(['a.ts', 'a.ts'], ['a.ts', 'a.ts'])).toEqual(['a.ts'])
  })
})
