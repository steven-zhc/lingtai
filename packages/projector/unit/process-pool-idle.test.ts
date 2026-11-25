import { KEPT_IDLE_MS } from '@lingtai/event-store'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'

import { PROCESS_PROJECTIONS } from '../src/choose.ts'
import { makePostgresProjections } from '../src/postgres.ts'

/** A pool that opens nothing: `listenForIdleErrors` is the only thing asked of it. */
const recording = () => {
  const configs: pg.PoolConfig[] = []
  const create = (config: pg.PoolConfig) => {
    configs.push(config)
    return { on: () => undefined } as unknown as pg.Pool
  }
  return { configs, create }
}

describe('the process projection pool keeps an idle connection (#1434)', () => {
  it('builds its pool with the idle time it was given', () => {
    const { configs, create } = recording()
    makePostgresProjections({ url: 'postgres://x/y', idleTimeoutMillis: 300_000 }, create)
    expect(configs[0]?.idleTimeoutMillis).toBe(300_000)
  })

  it('leaves pg’s default alone when none is given', () => {
    const { configs, create } = recording()
    makePostgresProjections({ url: 'postgres://x/y', max: 1 }, create)
    expect(configs[0]).toBeDefined()
    expect('idleTimeoutMillis' in (configs[0] ?? {})).toBe(false)
  })

  it('asks for KEPT_IDLE_MS on the process store, with allowExitOnIdle still on', () => {
    expect(PROCESS_PROJECTIONS).toEqual({ max: 4, allowExitOnIdle: true, idleTimeoutMillis: KEPT_IDLE_MS })
  })
})
