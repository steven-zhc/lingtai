/** The sandbox's mirror path is `@lingtai/repo`'s, without importing it (#1147): the recipe's resolver must not reach the event store. */
import { mirrorPathFor } from '@lingtai/repo'
import { mirrorDir } from '@lingtai/sandbox'
import { describe, expect, it } from 'vitest'

describe('mirrorDir', () => {
  it('is where the conductor puts the mirror', () => {
    const home = '/home/me/.lingtai'
    expect(mirrorDir({ platform: 'linux', home: '/home/me', tmpdir: '/tmp', stateDir: home, path: [] }, 'app')).toBe(
      mirrorPathFor('app', home),
    )
  })
})
