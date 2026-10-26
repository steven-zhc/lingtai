/**
 * There is one parser (#626): `@effect/cli`, behind `entry.ts`, and `lingtai.ts` is only the file a
 * supervisor's unit names. Read structurally where running would start a daemon.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Command } from '@effect/cli'
import { HashMap } from 'effect'
import { describe, expect, it } from 'vitest'

import { root } from '../src/cli.ts'
import { COMMANDS } from '../src/commands.ts'
import { routeOf } from '../src/migrated.ts'
import { BOARD_JOB, DAEMON_JOB } from '../src/service.ts'

describe('one parser', () => {
  it('sends what a supervisor starts the file with to @effect/cli', () => {
    expect(routeOf(DAEMON_JOB.argv)).toBe('effect')
    expect(routeOf(BOARD_JOB.argv)).toBe('effect')
  })

  it('leaves lingtai.ts as one import of the entry and nothing else', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/lingtai.ts', import.meta.url)), 'utf8')
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^#!.*$/m, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .trim()
    expect(code).toBe("import './entry.ts'")
  })

  it('has a subcommand for every definition and a definition for every subcommand', () => {
    const subcommands = [...HashMap.keys(Command.getSubcommands(root))].sort()
    expect(subcommands).toEqual(COMMANDS.map((c) => c.name).sort())
  })
})
