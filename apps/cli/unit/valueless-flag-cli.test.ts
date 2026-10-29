/** A flag that takes a value and is given none is a usage error, exit 2 (#715). */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { runCli } from '../src/cli.ts'

afterEach(() => vi.restoreAllMocks())

describe('a valueless flag on init and add', () => {
  it.each(['init', 'add'])('lingtai %s --store exits 2 and names the flag', async (command) => {
    let err = ''
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void (err += a.join(' ')))
    expect(await runCli(['node', 'lingtai', command, '--store'])).toBe(2)
    expect(err).toContain('--store takes a value')
  })
})
