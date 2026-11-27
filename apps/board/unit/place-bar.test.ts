/** The place bar keeps the project the URL names when the listings yield nothing or fail (#1499). */
import { describe, expect, it, vi } from 'vitest'

const listing = vi.hoisted(() => ({ registered: new Error('registry unreadable') as Error | never[] }))

vi.mock('@lingtai/env', () => ({ hasGitHubAuth: () => false }))
vi.mock('../src/lib/board', () => ({
  filterOptions: (registered: string[], onBoard: string[]) => [
    ...registered,
    ...onBoard.filter((p) => !registered.includes(p)),
  ],
  onBoardProjects: () => Promise.resolve([]),
}))
vi.mock('../src/lib/locks.ts', () => ({
  readRegistered: () =>
    listing.registered instanceof Error ? Promise.reject(listing.registered) : Promise.resolve(listing.registered),
  readProjectLocks: () => Promise.resolve([]),
}))
vi.mock('../src/lib/lock-marks.ts', () => ({ lockMap: () => new Map() }))
vi.mock('../src/lib/sandbox-state.ts', () => ({ sandboxStates: () => new Map() }))
vi.mock('../src/lib/prs.ts', () => ({ placeViewsOf: () => Promise.resolve([]) }))

const { readPlaceBar } = await import('../src/lib/place-bar.ts')

describe('readPlaceBar with nothing listed', () => {
  it('keeps the named project in the menu when the registry read fails, and says so', async () => {
    listing.registered = new Error('registry unreadable')
    const bar = await readPlaceBar('chapter-garden')
    expect(bar.filters).toEqual(['chapter-garden'])
    expect(bar.listingError).toBe('registry unreadable')
    expect(bar.isRegistered).toBe(false)
  })
  it('keeps an unregistered project on an empty installation', async () => {
    listing.registered = []
    expect((await readPlaceBar('z')).filters).toEqual(['z'])
  })
  it('names nothing for all projects', async () => {
    listing.registered = []
    expect((await readPlaceBar(undefined)).filters).toEqual([])
  })
})
