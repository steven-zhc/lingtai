/** `lingtai --help` and `lingtai <command> --help` (0121 §6–8, #617). */
import { backlogProjection, spendProjection, taskViewProjection } from '@lingtai/projector'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { COMMANDS, GROUPS, PROJECTION_NAMES, type CommandName } from '../src/commands.ts'
import { commandHelp, helpCommand, rootHelp } from '../src/help.ts'
import { INSTALL_ONLY, MIGRATED_COMMANDS, routeOf } from '../src/migrated.ts'
import { stripColour, width } from '../src/output.ts'

/** 0121 §7's table, written out here so changing a group is a change in two places. */
const ADR_GROUPS: Record<(typeof GROUPS)[number], string[]> = {
  everyday: ['add', 'run', 'status', 'now', 'attach', 'backlog', 'ticket', 'board', 'env', 'end'],
  'waiting on you': ['approve', 'answer', 'ask', 'grant-fix-round', 'requeue', 'close'],
  daemon: ['start', 'daemon', 'service', 'restart', 'shutdown', 'pause', 'resume'],
  'install and upkeep': ['init', 'version', 'upgrade', 'rollback', 'uninstall', 'doctor', 'projection'],
}

const saved = { ...process.env }
beforeEach(() => {
  process.env['NO_COLOR'] = '1'
})
afterEach(() => {
  vi.restoreAllMocks()
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
  Object.assign(process.env, saved)
})

function capture(argv: string[]): { code: number; out: string; err: string } {
  let out = ''
  let err = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((t: string | Uint8Array) => ((out += String(t)), true))
  vi.spyOn(process.stderr, 'write').mockImplementation((t: string | Uint8Array) => ((err += String(t)), true))
  return { code: helpCommand(argv), out, err }
}

const names = COMMANDS.map((c) => c.name)

describe('the definitions', () => {
  it('are 0121 §7’s table, each command in exactly one group', () => {
    for (const group of GROUPS) {
      expect(COMMANDS.filter((c) => c.group === group).map((c) => c.name)).toEqual(ADR_GROUPS[group])
    }
    expect(new Set(names).size).toBe(names.length)
  })

  it.each(names)('%s routes to something that answers it', (name) => {
    const route = routeOf([name])
    const expected = (MIGRATED_COMMANDS as readonly string[]).includes(name)
      ? 'effect'
      : name === 'init'
        ? 'init'
        : (INSTALL_ONLY as readonly string[]).includes(name)
          ? 'install'
          : 'lingtai'
    expect(route).toBe(expected)
    // `version`'s help is `@effect/cli`'s (#617); every other command's is the definition's (0121 §6).
    expect(routeOf([name, '--help'])).toBe(name === 'version' ? 'effect' : 'help')
  })

  it('carry a task, usage and an example, and name the projections', () => {
    for (const c of COMMANDS) {
      expect(c.task.length).toBeGreaterThan(0)
      expect(c.usage.length).toBeGreaterThan(0)
      expect(c.examples.length).toBeGreaterThan(0)
    }
    expect(PROJECTION_NAMES).toEqual([taskViewProjection, backlogProjection, spendProjection].map((p) => p.name))
    expect(commandHelp('projection')).toContain(PROJECTION_NAMES.join(', '))
  })
})

describe('lingtai --help', () => {
  it('lists every command once, under its own group', () => {
    const lines = rootHelp().split('\n')
    for (const group of GROUPS) {
      const at = lines.indexOf(group)
      expect(at).toBeGreaterThanOrEqual(0)
      const rest = lines.slice(at + 1)
      const block = rest.slice(0, rest.indexOf('') === -1 ? undefined : rest.indexOf(''))
      expect(block.map((l) => l.trim().split(/\s+/)[0])).toEqual(ADR_GROUPS[group])
    }
    for (const name of names) {
      expect(lines.filter((l) => l.startsWith('  ') && l.trim().split(/\s+/)[0] === name)).toHaveLength(1)
    }
    expect(lines.at(-1)).toBe('next: lingtai <command> --help')
  })

  it('exits 0 for a question and 2 for nothing, which a script must keep failing on', () => {
    expect(capture(['--help'])).toMatchObject({ code: 0, err: '' })
    expect(capture(['help']).out).toBe(`${rootHelp()}\n`)
    expect(capture([])).toMatchObject({ code: 2, out: '' })
  })

  it('refuses an unknown command by name, on stderr, with exit 2', () => {
    const r = capture(['bogus', '--help'])
    expect(r.code).toBe(2)
    expect(r.err).toContain('unknown command "bogus"')
    expect(r.out).toBe('')
  })
})

describe('lingtai <command> --help', () => {
  it.each(names.filter((n) => n !== 'version'))('%s: exits 0 with no project, no network and nothing run', (name) => {
    process.env['HOME'] = '/nonexistent'
    const r = capture([name, '--help'])
    expect(r.code).toBe(0)
    expect(r.err).toBe('')
    expect(r.out).toContain(`lingtai ${name}`)
    expect(r.out).toContain('examples')
    expect(r.out).not.toContain('no --help')
  })

  it('answers init, upgrade and uninstall, which refused --help before (#549)', () => {
    for (const name of ['init', 'upgrade', 'uninstall']) {
      const r = capture([name, '--help'])
      expect(r.code).toBe(0)
      expect(r.out).not.toContain('no --help')
    }
  })

  it('treats --help after other arguments as the question, not as a reason', () => {
    expect(capture(['shutdown', 'deploying', '--help']).out).toContain('lingtai shutdown')
  })

  it('says whether the command reads or changes', () => {
    expect(commandHelp('status')).toContain('reads only')
    expect(commandHelp('approve')).toContain('changes state')
  })
})

describe('layout', () => {
  const screens: [string, () => string][] = [
    ['root', rootHelp],
    ...names.map((n): [string, () => string] => [n, () => commandHelp(n as CommandName)]),
  ]

  it.each(screens)('%s fits 80 columns', (_name, render) => {
    for (const line of render().split('\n')) expect(width(line), line).toBeLessThanOrEqual(80)
  })

  it.each(screens)('%s is plain under NO_COLOR, and the same text with colour forced', (_name, render) => {
    const plain = render()
    expect(plain).not.toContain('\u001b')
    delete process.env['NO_COLOR']
    process.env['FORCE_COLOR'] = '1'
    expect(stripColour(render())).toBe(plain)
  })
})
