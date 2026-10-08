/**
 * `lockDir()`, since #273: a test run's lockers go in a directory this run
 * made for itself, never in the operator's own `~/.lingtai/locks` — the
 * directory that `pnpm test:integration` had been leaking 4567 files into.
 *
 * Pure: every case hands `lockDir` an object literal, so this needs no
 * filesystem.
 */
import { describe, expect, it } from 'vitest'

import { lockDir } from '../src/index.ts'

describe('lockDir', () => {
  it('is LINGTAI_TEST_LOCK_DIR under test', () => {
    expect(lockDir({ VITEST: 'true', LINGTAI_TEST_LOCK_DIR: '/x' })).toBe('/x')
  })

  it('throws, naming LINGTAI_TEST_LOCK_DIR, under test with neither it nor LINGTAI_HOME set', () => {
    expect(() => lockDir({ VITEST: 'true', HOME: '/h' })).toThrow(/LINGTAI_TEST_LOCK_DIR/)
  })

  it('is $LINGTAI_HOME/locks under test where LINGTAI_HOME is set, ahead of LINGTAI_TEST_LOCK_DIR', () => {
    expect(lockDir({ VITEST: 'true', LINGTAI_HOME: '/l' })).toBe('/l/locks')
  })

  it('is ~/.lingtai/locks outside a test', () => {
    expect(lockDir({ HOME: '/h' })).toBe('/h/.lingtai/locks')
  })
})
