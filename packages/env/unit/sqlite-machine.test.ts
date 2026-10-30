import { describe, expect, it } from 'vitest'

import { SQLITE_MACHINE } from '../src/index.ts'

describe('SQLITE_MACHINE', () => {
  it('names no directory, because the log is wherever LINGTAI_HOME puts it', () => {
    expect(SQLITE_MACHINE).not.toContain('~')
    expect(SQLITE_MACHINE).not.toContain('/')
  })
})
