/** The router's claim (#616): `version` is `@effect/cli`'s, and nothing else moved. */
import { describe, expect, it } from 'vitest'

import { routeOf } from '../src/migrated.ts'

describe('routeOf', () => {
  it.each([[['version']], [['version', '--json']], [['version', '--help']]])('sends %j to @effect/cli', (argv) => {
    expect(routeOf(argv)).toBe('effect')
  })

  it.each([
    [[], 'lingtai'],
    [['--help'], 'lingtai'],
    [['--version'], 'lingtai'],
    [['status'], 'lingtai'],
    [['daemon', '--no-conduct'], 'lingtai'],
    [['init'], 'init'],
    [['upgrade'], 'install'],
    [['rollback'], 'install'],
    [['uninstall'], 'install'],
  ])('leaves %j on its existing path (%s)', (argv, route) => {
    expect(routeOf(argv)).toBe(route)
  })
})
