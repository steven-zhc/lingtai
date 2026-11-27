import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { type Asker, type SetupInput, type SetupQuestion, runSetupList } from '../src/setup-list.ts'

type Ctx = { log: string[]; login?: string; seen?: boolean }

const die: Asker<Ctx> = () => Effect.die('asked')
const answering =
  (answer: string): Asker<Ctx> =>
  () =>
    Effect.succeed({ answer })

function q(id: string, over: Partial<SetupQuestion<Ctx>> = {}): SetupQuestion<Ctx> {
  return {
    id,
    name: `the ${id}`,
    flag: `--${id} <v>`,
    fromFlags: (flags) => flags[id] ?? null,
    write: (answer, _in, ctx) =>
      Effect.sync(() => {
        ctx.log.push(`${id}=${answer}`)
        return { wrote: true }
      }),
    row: (v) => v,
    ...over,
  }
}

const input = (over: Partial<SetupInput<Ctx>> = {}): SetupInput<Ctx> => ({
  interactive: false,
  defaults: false,
  flags: {},
  askers: {},
  log: () => {},
  ...over,
})

const run = (list: readonly SetupQuestion<Ctx>[], i: SetupInput<Ctx>) => {
  const ctx: Ctx = { log: [] }
  return Effect.runPromise(runSetupList(list, i, ctx)).then((out) => ({ out, ctx }))
}

describe('runSetupList', () => {
  it('skips a question that does not apply: not asked, not refused, even with its flag', async () => {
    const { out, ctx } = await run(
      [q('a', { applies: () => false }), q('b', { systemDefault: () => Effect.succeed('x') })],
      input({ flags: { a: 'whatever' }, askers: { a: die } }),
    )
    expect(out.refused).toBeUndefined()
    expect(out.entries[0]).toMatchObject({ id: 'a', applies: false, asked: false, wrote: false })
    expect(ctx.log).toEqual(['b=x'])
  })

  it('lets a non-applying question’s own fromFlags refuse', async () => {
    const { out } = await run(
      [q('a', { applies: () => false, fromFlags: () => ({ refused: 'no --a here' }) })],
      input(),
    )
    expect(out.refused).toBe('no --a here')
  })

  it('writes a fixed answer unasked, and refuses a contradicting flag', async () => {
    const fixed = q('a', {
      fixed: (_c, flag) => (flag !== null && flag !== 'db' ? { refused: 'a is db here' } : { answer: 'db' }),
    })
    const ok = await run([fixed], input({ interactive: true, askers: { a: die } }))
    expect(ok.out.entries[0]).toMatchObject({ after: 'db', asked: false, wrote: true })
    const bad = await run([fixed], input({ flags: { a: 'other' } }))
    expect(bad.out.refused).toBe('a is db here')
    expect(bad.ctx.log).toEqual([])
  })

  it('falls through to the asker where fixed says null', async () => {
    const { out } = await run(
      [q('a', { fixed: () => null })],
      input({ interactive: true, askers: { a: answering('asked-answer') } }),
    )
    expect(out.entries[0]).toMatchObject({ after: 'asked-answer', asked: true })
  })

  it('writes a derived answer with asked: false and calls no asker', async () => {
    const { out, ctx } = await run(
      [q('a', { derive: () => 'derived' })],
      input({ interactive: true, flags: { a: 'ignored' }, askers: { a: die } }),
    )
    expect(out.entries[0]).toMatchObject({ after: 'derived', asked: false, wrote: true })
    expect(ctx.log).toEqual(['a=derived'])
  })

  describe('confirm', () => {
    const c = q('c', { confirm: { declined: 'you declined' } })
    it('answers yes under --defaults', async () => {
      const { out } = await run([c], input({ defaults: true, askers: { c: die } }))
      expect(out.entries[0]).toMatchObject({ after: 'yes', asked: false })
    })
    it('is refused without a terminal, naming --defaults', async () => {
      const { out } = await run([c], input())
      expect(out.refused).toContain('pass --defaults')
    })
    it('is refused with its own words on no', async () => {
      const { out, ctx } = await run([c], input({ interactive: true, askers: { c: answering('no') } }))
      expect(out.refused).toBe('you declined')
      expect(ctx.log).toEqual([])
    })
    it('writes on yes', async () => {
      const { out } = await run([c], input({ interactive: true, askers: { c: answering('yes') } }))
      expect(out.entries[0]).toMatchObject({ after: 'yes', asked: true })
    })
    it('is asked after a switch answered yes, since only the flag answers it', async () => {
      const sw = q('sw', { defaultsSwitch: true })
      const { out } = await run(
        [sw, c],
        input({ interactive: true, askers: { sw: answering('yes'), c: answering('no') } }),
      )
      expect(out.refused).toBe('you declined')
      expect(out.entries).toHaveLength(1)
      expect(out.entries[0]).toMatchObject({ id: 'sw', after: 'yes' })
    })
    it('is asked after the switch, and written on yes', async () => {
      const sw = q('sw', { defaultsSwitch: true })
      const { out } = await run(
        [sw, c],
        input({ interactive: true, askers: { sw: answering('yes'), c: answering('yes') } }),
      )
      expect(out.entries[1]).toMatchObject({ id: 'c', after: 'yes', asked: true })
    })
    it('is still refused after a switch that had no terminal to ask on, naming --defaults', async () => {
      const sw = q('sw', { defaultsSwitch: true })
      const { out } = await run([sw, c], input())
      expect(out.refused).toContain('pass --defaults')
    })
    it('words its decline from what the walk has answered, where declined is a function', async () => {
      const seen = q('seen', { write: (a, _f, ctx) => Effect.sync(() => (ctx.log.push(`seen=${a}`), { wrote: true })) })
      const named = q('c', { confirm: { declined: (ctx) => `declined after ${ctx.log.join(',')}` } })
      const { out } = await run(
        [seen, named],
        input({ interactive: true, flags: { seen: 'one' }, askers: { c: answering('no') } }),
      )
      expect(out.refused).toBe('declined after seen=one')
    })
  })

  describe('a systemDefault that refuses', () => {
    let reads = 0
    const refusing = q('a', {
      systemDefault: () => {
        reads += 1
        return Effect.succeed({ refused: 'could not read the default' })
      },
    })
    it('is not read where a flag answered', async () => {
      reads = 0
      const { out } = await run([refusing], input({ flags: { a: 'given' } }))
      expect(reads).toBe(0)
      expect(out.refused).toBeUndefined()
      expect(out.entries[0]).toMatchObject({ after: 'given', wrote: true })
    })
    it('draws no default at a terminal, where the asker answers', async () => {
      let seen: unknown = 'unset'
      const { out } = await run(
        [refusing],
        input({
          interactive: true,
          askers: {
            a: (d) => {
              seen = d.default
              return Effect.succeed({ answer: 'typed' })
            },
          },
        }),
      )
      expect(seen).toBeNull()
      expect(out.entries[0]).toMatchObject({ after: 'typed', asked: true })
    })
    it("is the refusal, in the port's words, where nothing else answers", async () => {
      const { out } = await run([refusing], input())
      expect(out.refused).toBe('could not read the default')
      expect(out.entries).toEqual([])
    })
    it('is the refusal under --defaults too', async () => {
      const { out } = await run([refusing], input({ defaults: true }))
      expect(out.refused).toBe('could not read the default')
    })
    it('is the refusal at a terminal under --defaults, with no asker called', async () => {
      let asked = false
      const { out } = await run(
        [refusing],
        input({
          interactive: true,
          defaults: true,
          askers: {
            a: () => {
              asked = true
              return Effect.succeed({ answer: 'typed' })
            },
          },
        }),
      )
      expect(out.refused).toBe('could not read the default')
      expect(asked).toBe(false)
    })
  })

  it('stops the walk on a write that refuses', async () => {
    const { out, ctx } = await run(
      [
        q('a', { write: () => Effect.succeed({ refused: 'cannot' }) }),
        q('b', { systemDefault: () => Effect.succeed('x') }),
      ],
      input({ flags: { a: 'v' }, defaults: true }),
    )
    expect(out.refused).toBe('cannot')
    expect(out.entries).toEqual([])
    expect(ctx.log).toEqual([])
  })

  describe('defaultsSwitch', () => {
    const sw = q('sw', { defaultsSwitch: true })
    it('answered yes, makes later entries take defaults unasked, and tells systemDefault', async () => {
      let mode: unknown
      const later = q('b', {
        systemDefault: (_c, m) => {
          mode = m
          return Effect.succeed('dflt')
        },
      })
      const { out } = await run([sw, later], input({ interactive: true, askers: { sw: answering('yes'), b: die } }))
      expect(out.entries[1]).toMatchObject({ id: 'b', after: 'dflt', asked: false })
      expect(mode).toEqual({ defaults: true, interactive: true })
    })
    it('answered no leaves later entries asked', async () => {
      const { out } = await run(
        [sw, q('b')],
        input({ interactive: true, askers: { sw: answering('no'), b: answering('mine') } }),
      )
      expect(out.entries[1]).toMatchObject({ after: 'mine', asked: true })
    })
    it('under --defaults answers yes itself, with no default of its own, and the walk goes on', async () => {
      const { out, ctx } = await run(
        [sw, q('b', { systemDefault: () => Effect.succeed('dflt') })],
        input({ defaults: true, askers: { sw: die, b: die } }),
      )
      expect(out.refused).toBeUndefined()
      expect(out.entries[0]).toMatchObject({ id: 'sw', after: 'yes', asked: false })
      expect(out.entries[1]).toMatchObject({ id: 'b', after: 'dflt', asked: false })
      expect(ctx.log).toEqual(['sw=yes', 'b=dflt'])
    })
    it('with no terminal goes on without writing', async () => {
      const { out, ctx } = await run(
        [sw, q('b', { systemDefault: () => Effect.succeed('dflt') })],
        input({ askers: { sw: die } }),
      )
      expect(out.refused).toBeUndefined()
      expect(out.entries[0]).toMatchObject({ id: 'sw', asked: false, wrote: false, after: null })
      expect(ctx.log).toEqual(['b=dflt'])
    })
  })

  it('reads a later default from what an earlier write put in ctx', async () => {
    const { out } = await run(
      [
        q('a', {
          write: (answer, _in, ctx) =>
            Effect.sync(() => {
              ctx.login = answer
              return { wrote: true }
            }),
        }),
        q('b', { systemDefault: (ctx) => Effect.succeed(`${ctx.login}/studio`) }),
      ],
      input({ flags: { a: 'steven' } }),
    )
    expect(out.entries[1]).toMatchObject({ id: 'b', after: 'steven/studio' })
  })

  it('hands the asker ctx, and a validate that has ctx applied', async () => {
    let got: string | null = null
    const asker: Asker<Ctx> = (d) =>
      Effect.gen(function* () {
        got = yield* d.question.validate('v')
        return { answer: `${d.ctx.login}` }
      })
    const ctx: Ctx = { log: [], login: 'me' }
    const out = await Effect.runPromise(
      runSetupList(
        [q('a', { validate: (_a, c) => Effect.succeed(c.login === 'me' ? null : 'bad') })],
        input({ interactive: true, askers: { a: asker } }),
        ctx,
      ),
    )
    expect(got).toBeNull()
    expect(out.entries[0]).toMatchObject({ after: 'me' })
  })

  it('puts a question whose needed says no in deferred with no entry', async () => {
    const { out } = await run([q('a', { needed: () => Effect.succeed(false) })], input())
    expect(out.entries).toEqual([])
    expect(out.deferred.map((d) => d.id)).toEqual(['a'])
  })
})
