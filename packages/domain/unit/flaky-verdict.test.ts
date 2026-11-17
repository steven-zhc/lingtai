import { describe, expect, it } from 'vitest'

import {
  type BaseRecord,
  type FlakyInput,
  findingsRaisedOf,
  flakyClaim,
  flakyEntryOf,
  flakyVerdict,
  isFlakyFinding,
} from '../src/index.ts'

const ENTRY = 'src/a.test.ts > suite > does a thing'
const OUTPUT = [
  ` FAIL  ${ENTRY}`,
  'AssertionError: nope',
  ' Test Files  1 failed (3)',
  '      Tests  1 failed (9)',
].join('\n')
const seenOnBase: BaseRecord = { sha: 'abcdef1234567', ok: false, evidence: OUTPUT }

const holds = (over: Partial<FlakyInput> = {}): FlakyInput => ({
  command: 'pnpm test',
  first: OUTPUT,
  diffPaths: ['src/other.ts'],
  baseRecords: [seenOnBase],
  backlog: [],
  head: 'f'.repeat(40),
  ...over,
})

describe('flakyVerdict', () => {
  it('lets a red then green through when all three hold, with one minor finding per test', () => {
    const v = flakyVerdict(holds())
    expect(v.passed).toBe(true)
    if (!v.passed) return
    expect(v.findings).toHaveLength(1)
    const f = v.findings[0]!
    expect(f.severity).toBe('minor')
    expect(f.file).toBe('src/a.test.ts')
    expect(isFlakyFinding(f)).toBe(true)
    expect(f.claim).toBe(flakyClaim(ENTRY, 'pnpm test'))
    expect(f.claim).not.toContain('f'.repeat(40))
    expect(f.failureScenario).toContain('f'.repeat(40))
    expect(f.failureScenario).toContain('AssertionError: nope')
    expect(v.evidence).toContain('red then green')
    expect(v.evidence).toContain('abcdef1')
  })

  it('is red when the failing tests cannot be named', () => {
    const v = flakyVerdict(holds({ first: 'tsc: error TS2304' }))
    expect(v.passed).toBe(false)
    expect(v.evidence).toMatch(/^red then green; not let through because the failing tests could not be named/)
  })

  it('is red when the failing test file is in the diff, also under a subdirectory', () => {
    for (const diffPaths of [['src/a.test.ts'], ['packages/x/src/a.test.ts']]) {
      const v = flakyVerdict(holds({ diffPaths }))
      expect(v.passed).toBe(false)
      expect(v.evidence).toContain('src/a.test.ts is in this diff')
    }
  })

  it('is red when the diff could not be read', () => {
    const v = flakyVerdict(holds({ diffPaths: null }))
    expect(v.passed).toBe(false)
    expect(v.evidence).toContain('the diff could not be read')
  })

  it('is red when the test has not failed on the base before', () => {
    const v = flakyVerdict(holds({ baseRecords: [], backlog: [] }))
    expect(v.passed).toBe(false)
    expect(v.evidence).toContain(`${ENTRY} has not failed on the base before`)
    expect(v.evidence).toContain(OUTPUT)
  })

  it('counts a green record as no proof, and a record whose flaky names the test as proof', () => {
    expect(flakyVerdict(holds({ baseRecords: [{ sha: 'a', ok: true, evidence: '' }] })).passed).toBe(false)
    expect(flakyVerdict(holds({ baseRecords: [{ sha: 'a', ok: true, evidence: '', flaky: [ENTRY] }] })).passed).toBe(
      true,
    )
  })

  it('takes a backlog row in any status as proof', () => {
    const row = { file: 'src/a.test.ts', claim: flakyClaim(ENTRY, 'other command'), status: 'declined', key: 'k1' }
    const v = flakyVerdict(holds({ baseRecords: [], backlog: [row] }))
    expect(v.passed).toBe(true)
    expect(v.evidence).toContain('backlog row k1 (declined)')
  })

  it('is red when a read failed', () => {
    expect(flakyVerdict(holds({ baseRecords: null })).passed).toBe(false)
    const v = flakyVerdict(holds({ baseRecords: [], backlog: null }))
    expect(v.passed).toBe(false)
    expect(v.evidence).toContain('could not be read')
  })

  it('requires every named test to be known', () => {
    const second = 'src/b.test.ts > other'
    const first = [` FAIL  ${ENTRY}`, ` FAIL  ${second}`, ' Test Files  2 failed (3)'].join('\n')
    expect(flakyVerdict(holds({ first })).passed).toBe(false)
  })
})

describe('the flaky claim', () => {
  it('round-trips an entry containing any text, and is not made by other findings', () => {
    const weird = 'a.test.ts > failed then passed on a rerun of `x` > y'
    expect(flakyEntryOf(flakyClaim(weird, 'pnpm test'))).toBe(weird)
    expect(flakyEntryOf('something else')).toBeNull()
    expect(isFlakyFinding({ severity: 'major', claim: flakyClaim(ENTRY, 'c') })).toBe(false)
  })

  it('reaches findingsRaisedOf as a minor finding on the passed step', () => {
    const v = flakyVerdict(holds())
    if (!v.passed) throw new Error('expected passed')
    const event = {
      type: 'StepEnded',
      data: {
        runId: 'r1',
        outcome: {
          step: 'build',
          actions: [
            {
              name: 'check',
              yields: 'verdict',
              onSha: 'a'.repeat(40),
              result: { _tag: 'Completed', assessment: { verdict: 'accepted', findings: v.findings } },
            },
          ],
        },
      },
    } as never
    const raised = findingsRaisedOf(event)
    expect(raised).toHaveLength(1)
    expect(raised[0]!.assessment.findings[0]!.severity).toBe('minor')
    expect(raised[0]!.assessment.findings[0]!.claim).not.toMatch(/[0-9a-f]{40}|r1/)
  })
})
