/** `init` and `add` on `@effect/cli` (#620): what the options parse to, and the record the wizards read back out of it. */
import { Args, Command } from '@effect/cli'
import * as NodeContext from '@effect/platform-node/NodeContext'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { addOptions, flagsOf, initOptions, valuelessFlag, type WizardFlags } from '../src/wizard-options.ts'

async function parsedBy(
  command: 'init' | 'add',
  argv: readonly string[],
): Promise<(WizardFlags & { positional?: string }) | null> {
  let seen: (WizardFlags & { positional?: string }) | null = null
  const init = Command.make('init', initOptions, (args) =>
    Effect.sync(() => {
      seen = flagsOf(args)
    }),
  )
  const add = Command.make(
    'add',
    { repo: Args.text({ name: 'owner/repo' }).pipe(Args.optional), ...addOptions },
    ({ repo, ...rest }) =>
      Effect.sync(() => {
        seen = { ...(repo._tag === 'Some' ? { positional: repo.value } : {}), ...flagsOf(rest) }
      }),
  )
  const run = Command.run(Command.make('lingtai').pipe(Command.withSubcommands([init, add])), {
    name: 'lingtai',
    version: 'test',
  })
  await Effect.runPromise(
    run(['node', 'lingtai', command, ...argv]).pipe(
      Effect.provide(NodeContext.layer),
      Effect.catchAllCause(() => Effect.void),
    ),
  )
  return seen
}

describe('flagsOf', () => {
  it('maps an absent option to an absent key, --defaults to the empty string, and --build to its last value with every one kept', async () => {
    const parsed = await parsedBy('init', [
      '--defaults',
      '--build',
      'npm test',
      '--build',
      'npm run lint',
      '--store',
      'sqlite',
    ])
    expect(parsed).toEqual({
      flags: { defaults: '', build: 'npm run lint', store: 'sqlite' },
      repeated: { defaults: [''], build: ['npm test', 'npm run lint'], store: ['sqlite'] },
    })
  })

  it("keeps --model '' as an answer, and does not call it valueless (#736)", async () => {
    const parsed = await parsedBy('init', ['--model', ''])
    expect(parsed?.flags.model).toBe('')
    expect(valuelessFlag(['--model', ''])).toBeNull()
  })

  it('reads a bare init as no flags at all', async () => {
    expect(await parsedBy('init', [])).toEqual({ flags: {}, repeated: {} })
  })

  it('accepts --flag=value', async () => {
    expect((await parsedBy('init', ['--store=sqlite']))?.flags).toEqual({ store: 'sqlite' })
  })

  it.each([
    ['the flag first', ['--defaults', 'owner/repo']],
    ['the flag last', ['owner/repo', '--defaults']],
  ])('add reads the slug and --defaults with %s (#433)', async (_name, argv) => {
    expect(await parsedBy('add', argv)).toEqual({
      positional: 'owner/repo',
      flags: { defaults: '' },
      repeated: { defaults: [''] },
    })
  })

  it('add takes no positional when none is given', async () => {
    expect((await parsedBy('add', ['--local', '/repo']))?.positional).toBeUndefined()
  })

  it('accepts --no-color on both commands without making it a wizard flag', async () => {
    expect(await parsedBy('init', ['--no-color', '--store', 'sqlite'])).toEqual({
      flags: { store: 'sqlite' },
      repeated: { store: ['sqlite'] },
    })
    expect(await parsedBy('add', ['owner/repo', '--no-color'])).toEqual({
      positional: 'owner/repo',
      flags: {},
      repeated: {},
    })
    expect(valuelessFlag(['--no-color'])).toBeNull()
  })

  it('refuses a flag neither command has, where add used to ignore it', async () => {
    expect(await parsedBy('add', ['owner/repo', '--no-such-flag', 'x'])).toBeNull()
  })

  it.each([[['--build']], [['--store', '--defaults']], [['--defaults', '--build']]])(
    'names a flag given with no value, %j, where @effect/cli would drop it',
    (argv) => {
      expect(valuelessFlag(argv)).toBe(argv.find((a) => a !== '--defaults')!.slice(2))
    },
  )

  it('reads --yes as --defaults, and does not call it valueless (#700)', () => {
    expect(flagsOf({ yes: true })).toEqual({ flags: { defaults: '' }, repeated: { defaults: [''] } })
    expect(valuelessFlag(['--yes', '--local', '/repo'])).toBeNull()
  })

  it('does not call --defaults or --flag=value valueless', () => {
    expect(valuelessFlag(['--defaults', '--store=sqlite', '--build', 'npm test'])).toBeNull()
  })
})
