/**
 * **A red base is the project's, and the look compares two shas** (#1208, 0108 §13, 0122 §2).
 * Over the memory store and a head reader that counts how often it is asked.
 */
import { integrationStream, parsePayload } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import type { Recipe } from '@lingtai/recipe'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { lookAtBase, passOverBaseRed, type BaseHead } from '../src/base-red.ts'
import { passedOver, type Offered } from '../src/discover.ts'

const RED = 'a'.repeat(40)
const MOVED = 'b'.repeat(40)
const recipe = { steps: { build: [{ name: 'tests', run: 'pnpm test' }] } } as unknown as Recipe

const offered = (): Offered => ({
  runnable: [1, 2].map((n) => ({ ref: String(n), title: `t${n}`, kind: 'bug', parent: null, subIssues: null })),
  skipped: [],
  kindColors: {},
  dependenciesUnread: null,
})

async function stateOf(checks: { ok: boolean; command?: string }[]) {
  const store = createMemoryEventStore()
  for (const [i, c] of checks.entries()) {
    await store.append(integrationStream('p', 'main'), i, [
      {
        type: 'BaseChecked',
        actor: 'conductor',
        data: parsePayload('BaseChecked', {
          base: 'main',
          baseSha: RED,
          command: c.command ?? 'pnpm test',
          ok: c.ok,
          exitCode: c.ok ? 0 : 1,
          durationMs: 1,
          evidence: c.ok ? '' : 'boom',
          runId: `r${i}`,
        }),
      },
    ])
  }
  return store
}

function look(store: Awaited<ReturnType<typeof stateOf>>, head: BaseHead) {
  let asked = 0
  const result = Effect.runPromise(
    lookAtBase(
      { store, project: 'p', base: 'main', recipe },
      Effect.sync(() => {
        asked += 1
        return head
      }),
    ),
  ).then((looked) => ({ looked, asked }))
  return result
}

describe('the look at a red base', () => {
  it('passes every offered ticket over as base-red while the head is the red commit', async () => {
    const { looked } = await look(await stateOf([{ ok: false }]), { at: RED })
    const { offered: after, line } = passOverBaseRed(looked, offered())
    expect(after.runnable).toEqual([])
    expect(after.skipped.map((s) => [s.ref, s.reason])).toEqual([
      [1, 'base-red'],
      [2, 'base-red'],
    ])
    expect(line).toContain('`pnpm test` failed on aaaaaaa')
    expect(passedOver(after.skipped)).toBe('2 passed over — base-red 2')
  })

  it('skips nothing once the head has moved', async () => {
    const { looked } = await look(await stateOf([{ ok: false }]), { at: MOVED })
    const { offered: after, line } = passOverBaseRed(looked, offered())
    expect(after.runnable).toHaveLength(2)
    expect(after.skipped).toEqual([])
    expect(line).toBeNull()
  })

  it('passes the tickets over, and says why, when the head cannot be read', async () => {
    const { looked } = await look(await stateOf([{ ok: false }]), { unreadable: 'git fetch failed' })
    const { offered: after, line } = passOverBaseRed(looked, offered())
    expect(after.runnable).toEqual([])
    expect(line).toBe('base-red: git fetch failed — 2 passed over this look')
  })

  it('never reads the head when the base is green, never checked, or red on a command the recipe no longer builds', async () => {
    for (const checks of [[], [{ ok: false }, { ok: true }], [{ ok: false, command: 'pnpm old' }]]) {
      const { looked, asked } = await look(await stateOf(checks), { at: RED })
      expect(asked).toBe(0)
      expect(passOverBaseRed(looked, offered()).offered.runnable).toHaveLength(2)
    }
  })

  it('passes the tickets over when the base log cannot be read: unknown is not green', async () => {
    const store = { read: async () => Promise.reject(new Error('db down')) } as never
    const { looked } = await look(store, { at: MOVED })
    const { offered: after, line } = passOverBaseRed(looked, offered())
    expect(after.runnable).toEqual([])
    expect(line).toContain('db down')
  })
})
