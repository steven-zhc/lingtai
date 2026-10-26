/** `lingtai events` (#633): `--json` is `doc/events.json` in 0121's envelope; the rendering is held to a small hand-built manifest. */
import { readFileSync } from 'node:fs'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EventsDoc } from '../../../packages/domain/scripts/events.ts'
import { runCli } from '../src/cli.ts'
import { eventsBySection, findEvent, renderEvent, renderEvents } from '../src/events.ts'

async function capture(args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((t: string | Uint8Array) => ((out += String(t)), true))
  vi.spyOn(process.stderr, 'write').mockImplementation((t: string | Uint8Array) => ((err += String(t)), true))
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void (out += `${a.join(' ')}\n`))
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void (err += `${a.join(' ')}\n`))
  const code = await runCli(['node', 'lingtai', ...args])
  return { code, out, err }
}

const saved = process.env['NO_COLOR']
beforeEach(() => {
  process.env['NO_COLOR'] = '1'
})
afterEach(() => {
  vi.restoreAllMocks()
  if (saved === undefined) delete process.env['NO_COLOR']
  else process.env['NO_COLOR'] = saved
})

const committed = JSON.parse(readFileSync(new URL('../../../doc/events.json', import.meta.url), 'utf8')) as EventsDoc

const entry = (name: string, at: string[], extra: Partial<EventsDoc['events'][number]> = {}) => ({
  name,
  group: 'g',
  stream: ['ticket-'] as const,
  schemaVersion: 1,
  retired: false,
  at,
  summary: null,
  definition: `https://example.test/${name}`,
  sites: [`https://example.test/site/${name}`],
  subscribers: 'none',
  ...extra,
})

const small = {
  sha: 'abc',
  events: [
    entry('Late', ['outside']),
    entry('Both', ['end', 'claim']),
    entry('Gone', [], { retired: true }),
    entry('Early', ['claim'], { summary: 'says a thing' }),
  ],
} as EventsDoc

describe('lingtai events --json', () => {
  it('is the committed manifest inside the envelope', async () => {
    const { code, out } = await capture(['events', '--json'])
    const { version, command, ...rest } = JSON.parse(out)
    expect(code).toBe(0)
    expect(version).toBe(1)
    expect(command).toBe('events')
    expect(rest).toEqual(committed)
  })

  it('with a name is the same shape holding that one event', async () => {
    const name = committed.events[0]!.name
    const { code, out } = await capture(['events', name.toLowerCase(), '--json'])
    const { version: _v, command: _c, ...rest } = JSON.parse(out)
    expect(code).toBe(0)
    expect(rest).toEqual({ sha: committed.sha, events: [committed.events[0]] })
  })

  it('names an unknown event as an error document and exits 1', async () => {
    const { code, out } = await capture(['events', 'NoSuchEvent', '--json'])
    expect(code).toBe(1)
    expect(JSON.parse(out).error.code).toBe('unknown-event')
  })

  it('says so in words without --json', async () => {
    const { code, err } = await capture(['events', 'NoSuchEvent'])
    expect(code).toBe(1)
    expect(err).toContain('lingtai events')
  })
})

describe('rendering', () => {
  it('orders sections by step with outside last, lists a multi-step event under each, and drops a retired one', () => {
    const sections = eventsBySection(small)
    expect(sections.map(([at]) => at)).toEqual(['claim', 'end', 'outside'])
    expect(sections[0]![1].map((e) => e.name)).toEqual(['Both', 'Early'])
    expect(sections[1]![1].map((e) => e.name)).toEqual(['Both'])
    expect(sections.flatMap(([, l]) => l.map((e) => e.name))).not.toContain('Gone')
  })

  it('prints one heading per section, each event with its definition and append-site links', () => {
    const text = renderEvents(small).join('\n')
    expect(text).toContain('claim')
    expect(text).toContain('https://example.test/Late')
    expect(text).toContain('https://example.test/site/Late')
  })

  it('shows one event with its sites and summary when it has one', () => {
    const text = renderEvent(findEvent(small, 'early')!).join('\n')
    expect(text).toContain('says a thing')
    expect(text).toContain('https://example.test/site/Early')
    expect(renderEvent(findEvent(small, 'Late')!).join('\n')).not.toContain('summary')
  })

  it('finds a retired event, and says it is retired', () => {
    expect(renderEvent(findEvent(small, 'Gone')!).join('\n')).toMatch(/retired\s+yes/)
  })
})
