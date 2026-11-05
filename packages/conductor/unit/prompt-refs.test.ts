import { createHash } from 'node:crypto'

import { DIFF_FLAGS, composePrompt, expandPrompt } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { describe, expect, it } from 'vitest'

import { resolvePromptRefs, type PromptRefPorts } from '../src/prompt-refs.ts'

const FROM = 'a'.repeat(40)
const TO = 'b'.repeat(40)
const DIFF = '--- a/x\n+++ b/x\n+é\n'
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

async function fixture() {
  const store = createMemoryEventStore()
  await store.append('ticket-p-1', 0, [
    {
      type: 'TicketClaimed',
      actor: 'conductor',
      data: { runId: 'r', worker: 'w', title: 't', kind: 'bug', body: 'the body' } as never,
    },
  ])
  const c = composePrompt([
    'x ',
    { text: 'the body', ref: { _tag: 'TicketBody', stream: 'ticket-p-1', version: 1 } },
    ' ',
    { text: DIFF, ref: { _tag: 'Diff', from: FROM, to: TO } },
  ])
  const entries = c.refs.map((r, i) => ({ ...r, sha256: sha(c.values[i]!) }))
  const calls: { args: readonly string[]; cwd: string }[] = []
  const ports: PromptRefPorts = {
    store,
    mirrorPath: '/home/.lingtai/repos/p.git',
    git: async (args, cwd) => {
      calls.push({ args, cwd })
      return args[0] === 'cat-file' ? { ok: true, out: '' } : { ok: true, out: DIFF }
    },
  }
  return { c, entries, ports, calls, store }
}

describe('resolvePromptRefs (#927)', () => {
  it('resolves a body from the log and a diff from the mirror, to what the expansion needs', async () => {
    const { c, entries, ports, calls } = await fixture()
    const values = await resolvePromptRefs(entries, ports)
    expect(values).toEqual([{ text: 'the body' }, { text: DIFF }])
    const diff = calls.find((call) => call.args[0] === 'diff')!
    expect(diff.args).toEqual(['diff', ...DIFF_FLAGS, `${FROM}...${TO}`])
    expect(diff.cwd).toBe('/home/.lingtai/repos/p.git')
    expect(expandPrompt({ prompt: c.recorded, refs: c.refs }, values)).toEqual({ text: c.handed, unresolved: [] })
  })

  it('says why: a missing event, an event with no body, another type', async () => {
    const { entries, ports, store } = await fixture()
    const body = entries[0]!
    const at = (version: number) => ({ ...body, ref: { _tag: 'TicketBody' as const, stream: 'ticket-p-1', version } })
    await store.append('ticket-p-1', 1, [
      { type: 'TicketContinued', actor: 'conductor', data: { runId: 'r', worker: 'w' } as never },
      {
        type: 'RunPrompted',
        actor: 'conductor',
        data: { promptVersion: 'x', bytes: 1, prompt: 'x' } as never,
      },
    ])
    const got = await resolvePromptRefs([at(9), at(2), at(3)], ports)
    expect(got).toEqual([
      { unresolved: 'ticket-p-1 has no event at version 9' },
      { unresolved: 'the TicketContinued at ticket-p-1@2 holds no body' },
      { unresolved: 'the event at ticket-p-1@3 is a RunPrompted, not a claim' },
    ])
  })

  it('a git failure, a commit the mirror lacks, a size mismatch and a hash mismatch are unresolved, never thrown', async () => {
    const { entries, ports } = await fixture()
    const diff = entries[1]!
    const failing = await resolvePromptRefs([diff], {
      ...ports,
      git: async (args) => (args[0] === 'cat-file' ? { ok: true, out: '' } : { ok: false, why: 'boom' }),
    })
    expect(failing).toEqual([{ unresolved: 'git diff failed: boom' }])

    const missing = await resolvePromptRefs([diff], { ...ports, git: async () => ({ ok: false, why: 'bad object' }) })
    expect(missing).toEqual([{ unresolved: `${FROM} is not in the mirror` }])

    const short = await resolvePromptRefs([diff], {
      ...ports,
      git: async (args) => ({ ok: true, out: args[0] === 'diff' ? 'x' : '' }),
    })
    expect(short[0]).toMatchObject({ unresolved: expect.stringContaining('git produced 1 bytes') })

    const same = DIFF.replace('é', 'e ')
    expect(Buffer.byteLength(same)).toBe(Buffer.byteLength(DIFF))
    const swapped = await resolvePromptRefs([diff], {
      ...ports,
      git: async (args) => ({ ok: true, out: args[0] === 'diff' ? same : '' }),
    })
    expect(swapped).toEqual([{ unresolved: "the value's sha256 differs from the record's" }])

    const syncThrow = await resolvePromptRefs([entries[0]!, diff], {
      ...ports,
      store: {
        read: () => {
          throw new Error('sync read')
        },
      },
    })
    expect(syncThrow[0]).toEqual({ unresolved: 'sync read' })
    expect(syncThrow[1]).toEqual({ text: DIFF })

    const thrown = await resolvePromptRefs([diff], {
      ...ports,
      git: async () => {
        throw new Error('spawn failed')
      },
    })
    expect(thrown).toEqual([{ unresolved: 'spawn failed' }])
  })
})
