/** The release notes' *CLI changed* section is a function of two manifests (#634). */
import { describe, expect, it } from 'vitest'

import { diffCli, parseManifest, renderCliChanged } from '../src/cli-diff.ts'
import type { Manifest, ManifestCommand } from '../src/cli-doc.ts'

const cmd = (name: string, o: Partial<ManifestCommand> = {}): ManifestCommand => ({
  name,
  group: 'everyday',
  task: '',
  effect: 'reads',
  usage: [],
  examples: [],
  flags: [],
  json: null,
  ...o,
})
const man = (...commands: ManifestCommand[]): Manifest => ({ version: 1, commands })
const none = { added: [], removed: [], changed: [] }

describe('diffCli', () => {
  it('reports nothing for equal manifests, and ignores prose', () => {
    expect(diffCli(man(cmd('a')), man(cmd('a', { task: 'x', usage: ['y'] })))).toEqual(none)
  })

  it('reports an added and a removed command, without their flags', () => {
    const c = diffCli(man(cmd('a', { flags: ['--x'] })), man(cmd('b', { flags: ['--y'] })))
    expect(c).toEqual({ added: ['b'], removed: ['a'], changed: [] })
  })

  it('reports flags added and removed', () => {
    const c = diffCli(man(cmd('a', { flags: ['--x', '--y'] })), man(cmd('a', { flags: ['--y', '--z'] })))
    expect(c.changed).toEqual([{ name: 'a', flagsAdded: ['--z'], flagsRemoved: ['--x'], json: null, effect: null }])
  })

  it('reports a --json version bump', () => {
    const f = ['--json']
    const c = diffCli(man(cmd('a', { flags: f, json: 1 })), man(cmd('a', { flags: f, json: 2 })))
    expect(c.changed[0]?.json).toEqual({ from: 1, to: 2 })
  })

  it('reads --json appearing as a flag added, with no bump', () => {
    const c = diffCli(man(cmd('a')), man(cmd('a', { flags: ['--json'], json: 1 })))
    expect(c.changed).toEqual([{ name: 'a', flagsAdded: ['--json'], flagsRemoved: [], json: null, effect: null }])
  })

  it('reports an effect change', () => {
    const c = diffCli(man(cmd('a')), man(cmd('a', { effect: 'changes' })))
    expect(c.changed[0]?.effect).toEqual({ from: 'reads', to: 'changes' })
  })
})

describe('renderCliChanged', () => {
  const next = man(cmd('a'))

  it('says so when there is no previous manifest', () => {
    expect(renderCliChanged({ previousTag: null, previous: null, next })).toBe(
      '## CLI changed\n\nFirst release with a CLI manifest.\n',
    )
    expect(renderCliChanged({ previousTag: 'v0.9.0', previous: null, next })).toContain('(v0.9.0 has none)')
  })

  it('says nothing changed', () => {
    expect(renderCliChanged({ previousTag: 'v1', previous: next, next })).toContain('since v1.')
  })

  it('lists each category and one line per changed command', () => {
    const previous = man(cmd('a', { flags: ['--json'], json: 1 }), cmd('gone'))
    const after = man(cmd('a', { flags: ['--all', '--json'], json: 2, effect: 'changes' }), cmd('new'))
    const text = renderCliChanged({ previousTag: 'v1', previous, next: after })
    expect(text).toContain('**Commands added**\n\n- `new`')
    expect(text).toContain('**Commands removed**\n\n- `gone`')
    expect(text).toContain('- `a`: `--all` added, `--json` 1 → 2, now changes state')
  })
})

describe('parseManifest', () => {
  it('accepts a version 1 manifest', () => {
    expect(parseManifest(JSON.stringify(man(cmd('a'))))).toEqual(man(cmd('a')))
  })

  it('refuses another version and a malformed commands list', () => {
    expect(() => parseManifest('{"version":2,"commands":[]}', 'p')).toThrow('p is not a version 1')
    expect(() => parseManifest('{"version":1,"commands":[{"name":"a"}]}')).toThrow('not a CLI manifest')
    expect(() => parseManifest('null')).toThrow('version 1')
  })
})
