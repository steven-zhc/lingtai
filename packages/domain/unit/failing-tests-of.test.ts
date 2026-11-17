import { describe, expect, it } from 'vitest'

import { failingTestsOf } from '../src/failure/tests.ts'

const fail =
  ' FAIL   unit  apps/cli/unit/triage-catch-up.test.ts > triage catch-up > catches up every project on a lifted day\n' +
  "AssertionError: expected [] to deeply equal [ 'b' ]\n"
const header = 'pnpm typecheck && pnpm test exited 1 after 60.5s\n\n'

describe('failingTestsOf', () => {
  it('names the failing test, title included, without the project label', () => {
    const out = `${header}${fail}\n Test Files  1 failed | 536 passed (537)\n`
    expect(failingTestsOf(out)).toEqual([
      'apps/cli/unit/triage-catch-up.test.ts > triage catch-up > catches up every project on a lifted day',
    ])
  })
  it('answers null with no summary', () => {
    expect(failingTestsOf(header + fail)).toBeNull()
  })
  it('answers null when the summary counts more files than the FAIL lines name', () => {
    expect(failingTestsOf(`${fail}\n Test Files  2 failed | 5 passed (7)\n`)).toBeNull()
  })
  it('names a file-only failure as the file', () => {
    expect(failingTestsOf(' FAIL  a/b.test.ts\n Test Files  1 failed (1)\n')).toEqual(['a/b.test.ts'])
  })
  it('answers null for tsc output', () => {
    expect(failingTestsOf('src/a.ts(1,2): error TS2322: nope\n')).toBeNull()
  })
})
