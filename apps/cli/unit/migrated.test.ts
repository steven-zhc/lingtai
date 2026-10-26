/** The router's claim (#616): `version` is `@effect/cli`'s, and nothing else moved. */
import { describe, expect, it } from 'vitest'

import { routeOf } from '../src/migrated.ts'

describe('routeOf', () => {
  it.each([
    [['version']],
    [['version', '--json']],
    [['version', '--help']],
    [['status']],
    [['status', 'lingtai', '--json']],
    [['status', '--all', 'lingtai']],
    [['doctor']],
    [['doctor', '--json']],
    [['init']],
    [['init', '--store', 'sqlite', '--defaults']],
    [['add', 'owner/repo']],
    [['add', '--local', '.', '--defaults']],
    [['approve', 'lingtai', '--issue', '617']],
    [['requeue', 'lingtai', '--issue', '617', '--note', 'base moved']],
    [['grant-fix-round', 'lingtai', '--issue', '617', '--if-head', '53fe949']],
    [['close', 'lingtai', '--issue', '617', 'superseded by 9']],
    [['answer', 'lingtai', '--issue', '617', 'use the second option']],
    [['ask', 'lingtai', '--issue', '617', 'which groups?']],
    [['now', 'lingtai', '--issue', '617', '--json']],
    [['board']],
    [['board', 'status']],
    [['board', '--port', '1', '--no-open']],
  ])('sends %j to @effect/cli', (argv) => {
    expect(routeOf(argv)).toBe('effect')
  })

  it.each([
    [[], 'help'],
    [['--help'], 'help'],
    [['-h'], 'help'],
    [['help'], 'help'],
    [['init', '--help'], 'help'],
    [['add', '--help'], 'help'],
    [['upgrade', '--help'], 'help'],
    [['status', '--help'], 'help'],
    [['doctor', '--help'], 'help'],
    [['approve', '--help'], 'help'],
    [['requeue', '--help'], 'help'],
    [['grant-fix-round', '--help'], 'help'],
    [['close', '--help'], 'help'],
    [['answer', '--help'], 'help'],
    [['ask', '--help'], 'help'],
    [['now', '--help'], 'help'],
    [['shutdown', '-h'], 'help'],
    [['board', 'start', '--help'], 'help'],
    // A whole argument, never a substring: this one is a question's text.
    [['ask', 'p', '--issue', '1', 'what --help'], 'effect'],
    [['--version'], 'lingtai'],
    [['daemon', '--no-conduct'], 'lingtai'],
    [['upgrade'], 'install'],
    [['rollback'], 'install'],
    [['uninstall'], 'install'],
  ])('leaves %j on its existing path (%s)', (argv, route) => {
    expect(routeOf(argv)).toBe(route)
  })
})
