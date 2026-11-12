/**
 * The Effect port over the SQLite twin (#1046): what a face must keep of the
 * promise store, and what the port adds. `:memory:` has no file, so this stays
 * a unit test (0060 §1).
 */
import { Deferred, Effect, Exit, Fiber } from 'effect'
import { describe, expect, it } from 'vitest'

import { createSqliteProjectionStore, makeSqliteProjections, openSqliteProjections } from '../src/sqlite.ts'
import { promiseProjectionStore, tasksFace } from '../src/store-face.ts'
import { CheckpointRewoundError } from '../src/store.ts'

const ddl = 'create table if not exists t (id integer primary key)'

describe('Projections over SQLite', () => {
  it('refuses a read from inside its own transaction rather than hanging', async () => {
    const port = makeSqliteProjections(openSqliteProjections(':memory:'))
    const store = promiseProjectionStore(port)
    const seen = await Promise.race([
      store
        .transact(() => tasksFace(port, { retentionDays: 1 }))
        .then(
          () => 'resolved',
          (err: Error) => err.message,
        ),
      new Promise<string>((r) => setTimeout(() => r('hung'), 1000)),
    ])
    expect(seen).toMatch(/inside its own transaction/)
  })

  it('keeps CheckpointRewoundError and the error a reducer threw', async () => {
    const store = createSqliteProjectionStore(openSqliteProjections(':memory:'))
    await store.transact(async (ctx) => {
      await ctx.query(ddl)
      await store.advance(ctx, 'p', 5n)
    })
    await expect(
      store.transact(async (ctx) => {
        await ctx.query('insert into t values (1)')
        await store.advance(ctx, 'p', 9n, 7n)
      }),
    ).rejects.toBeInstanceOf(CheckpointRewoundError)
    expect(await store.checkpoint('p')).toBe(5n)
    expect(await store.transact((ctx) => ctx.query('select * from t'))).toEqual([])

    const boom = new Error('reducer')
    await expect(
      store.transact(async (ctx) => {
        await ctx.query('insert into t values (2)')
        throw boom
      }),
    ).rejects.toBe(boom)
    expect(await store.transact((ctx) => ctx.query('select * from t'))).toEqual([])
  })

  it('rolls back and frees the permit when interrupted while fn is suspended', async () => {
    const db = openSqliteProjections(':memory:')
    const port = makeSqliteProjections(db)
    // The face over the very port interrupted, so one permit is what is checked.
    const store = promiseProjectionStore(port)
    await store.transact((ctx) => ctx.query(ddl))
    let finalised = false
    const run = Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const fiber = yield* Effect.forkChild(
        port.transact((ctx) =>
          Effect.gen(function* () {
            yield* ctx.query('insert into t values (3)')
            yield* Deferred.succeed(started, undefined)
            yield* Effect.never.pipe(
              // A finalizer that is asynchronous still runs inside the transaction.
              Effect.ensuring(
                Effect.andThen(
                  Effect.andThen(Effect.sleep(20), ctx.query('insert into t values (5)')),
                  Effect.sync(() => {
                    finalised = true
                  }),
                ),
              ),
            )
          }),
        ),
      )
      yield* Deferred.await(started)
      return yield* Fiber.interrupt(fiber)
    })
    const exit = await Effect.runPromise(Effect.exit(run))
    expect(Exit.isSuccess(exit)).toBe(true)
    // The interrupt waited for the callback's asynchronous finalizer, which wrote row 5.
    expect(finalised).toBe(true)
    await store.transact((ctx) => ctx.query('insert into t values (4)'))
    expect(await store.transact((ctx) => ctx.query<{ id: number }>('select id from t'))).toEqual([{ id: 4 }]) // rows 3 and 5 are gone
  })
})
