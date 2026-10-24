/** 0118 §12's split plan: one test per way a plan can be wrong, and one that is not. */
import { describe, expect, it } from 'vitest'

import { splitPlanProblems, type SplitPlanShape } from '../src/split.ts'
import { Resolution, TriageResult } from '../src/wait.ts'

const child = (key: string, kind = 'feature') => ({ key, title: `do ${key}`, body: `work on ${key}`, kind })
const KINDS = ['bug', 'feature']

const diamond: SplitPlanShape = {
  children: [child('a'), child('b'), child('c'), child('d')],
  blockedBy: [
    { ticket: 'b', blockedBy: 'a' },
    { ticket: 'c', blockedBy: 'a' },
    { ticket: 'd', blockedBy: 'b' },
    { ticket: 'd', blockedBy: 'c' },
  ],
}

const tags = (plan: SplitPlanShape, kinds: readonly string[] | undefined = KINDS) =>
  splitPlanProblems(plan, { kinds }).map((p) => p._tag)

describe('splitPlanProblems', () => {
  it('accepts a diamond', () => {
    expect(splitPlanProblems(diamond, { kinds: KINDS })).toEqual([])
  })

  it('refuses one child', () => {
    expect(tags({ children: [child('a')], blockedBy: [] })).toEqual(['TooFewChildren'])
  })

  it('refuses a duplicate key', () => {
    expect(tags({ children: [child('a'), child('a')], blockedBy: [] })).toEqual(['DuplicateKey'])
  })

  it('refuses a key that is not a slug', () => {
    expect(tags({ children: [child('A b'), child('c')], blockedBy: [] })).toEqual(['BadKey'])
  })

  it('refuses a blank title and a blank body', () => {
    const plan = {
      children: [
        { ...child('a'), title: ' ' },
        { ...child('b'), body: '\n' },
      ],
      blockedBy: [],
    }
    expect(splitPlanProblems(plan)).toEqual([
      { _tag: 'BlankTitle', key: 'a' },
      { _tag: 'BlankBody', key: 'b' },
    ])
  })

  it('refuses a dependency naming a missing node', () => {
    expect(splitPlanProblems({ ...diamond, blockedBy: [{ ticket: 'a', blockedBy: 'zz' }] })).toEqual([
      { _tag: 'MissingNode', key: 'zz' },
    ])
  })

  it('refuses a self-dependency', () => {
    expect(tags({ ...diamond, blockedBy: [{ ticket: 'a', blockedBy: 'a' }] })).toEqual(['SelfDependency'])
  })

  it('refuses a repeated edge', () => {
    const edge = { ticket: 'b', blockedBy: 'a' }
    expect(tags({ ...diamond, blockedBy: [edge, edge] })).toEqual(['DuplicateDependency'])
  })

  it('refuses a two-node cycle and names its keys', () => {
    const problems = splitPlanProblems({
      ...diamond,
      blockedBy: [
        { ticket: 'a', blockedBy: 'b' },
        { ticket: 'b', blockedBy: 'a' },
      ],
    })
    expect(problems).toEqual([{ _tag: 'Cycle', keys: ['a', 'b', 'a'] }])
  })

  it('refuses a three-node cycle', () => {
    const problems = splitPlanProblems({
      ...diamond,
      blockedBy: [
        { ticket: 'a', blockedBy: 'b' },
        { ticket: 'b', blockedBy: 'c' },
        { ticket: 'c', blockedBy: 'a' },
      ],
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatchObject({ _tag: 'Cycle' })
  })

  it('refuses a kind the recipe does not read, only when kinds are given', () => {
    const plan = { ...diamond, children: [child('a', 'chore'), ...diamond.children.slice(1)] }
    expect(splitPlanProblems(plan, { kinds: KINDS })).toEqual([{ _tag: 'UnknownKind', key: 'a', kind: 'chore' }])
    expect(splitPlanProblems(plan)).toEqual([])
  })
})

describe('the schemas call the same checks', () => {
  it('Resolution parses a sound Split and refuses a cyclic one', () => {
    expect(Resolution.safeParse({ _tag: 'Split', ...diamond }).success).toBe(true)
    const cyclic = {
      ...diamond,
      blockedBy: [
        { ticket: 'a', blockedBy: 'b' },
        { ticket: 'b', blockedBy: 'a' },
      ],
    }
    expect(Resolution.safeParse({ _tag: 'Split', ...cyclic }).success).toBe(false)
  })

  const advice = (cause: unknown, resolution = 'Split') => ({
    _tag: 'TriageAdvised',
    cause,
    resolution,
    summary: 's',
    want: null,
  })

  it('TriageResult accepts Split advice only with a TicketTooBig that carries a plan', () => {
    expect(TriageResult.safeParse(advice({ _tag: 'TicketTooBig', split: diamond })).success).toBe(true)
    expect(TriageResult.safeParse(advice({ _tag: 'TicketTooBig' })).success).toBe(false)
    expect(TriageResult.safeParse(advice({ _tag: 'WrongApproach' })).success).toBe(false)
  })

  it('a bare TicketTooBig still parses with other advice', () => {
    expect(TriageResult.safeParse(advice({ _tag: 'TicketTooBig' }, 'EditBodyAndRequeue')).success).toBe(true)
  })

  it('refuses a proposal past the children cap', () => {
    const many = { children: Array.from({ length: 9 }, (_, i) => child(`k${i}`)), blockedBy: [] }
    expect(TriageResult.safeParse(advice({ _tag: 'TicketTooBig', split: many })).success).toBe(false)
  })
})
