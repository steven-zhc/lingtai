import { describe, expect, it } from 'vitest'

/**
 * `lingtai board start|stop|restart|status` (#187) — the verbs, against a world
 * that holds no lock, signals nothing and starts no server. What these pin is
 * what each verb *says* and *whom it signals*: a board the supervisor keeps is
 * respawned in thirty seconds, so a signal sent to it here is a second board
 * racing the first for the port.
 */
import {
  boardCommand,
  boardLock,
  holdingProcess,
  stopOnSignal,
  type BoardCommand,
  type BoardWorld,
} from '../src/board.ts'
import { BOARD_WAIT_MS, type Keeper } from '../src/service.ts'

const PORT = 17820
const URL = `http://127.0.0.1:${PORT}`

function world(
  over: Partial<BoardWorld> & {
    holder?: string | null
    /** Whether a supervisor keeps the board's job — a keeper that answers as the real one does. */
    kept?: boolean
    /**
     * How many asks after `bootout` the supervisor goes on saying it has the
     * job. `bootout` returns while the job is still running, so this is the
     * ordinary case and not a pathological one; `Infinity` is a job that never
     * goes.
     */
    jobGoesAfter?: number
  } = {},
) {
  const out: string[] = []
  const err: string[] = []
  const calls: string[] = []
  const signalled: number[] = []
  let holder: string | null = over.holder ?? null
  /** The supervisor's job: gone only once it has been asked for *and* let go. */
  let booted = false
  let asksSinceBootout = 0
  let keeperAsks = 0
  const w: BoardWorld = {
    host: '127.0.0.1',
    hostname: 'mac',
    answering: async () => null,
    bound: async () => false,
    locker: {
      tryLock: async (_key, name) => {
        if (holder !== null) return { ok: false, holder }
        holder = `${name} pid 500 on mac`
        return { ok: true, lock: { release: async () => void (holder = null) } }
      },
      holder: async () => holder,
    },
    // The supervised job runs `board start` with no `--port`, so the board it
    // keeps is on this machine's port and on no other — which is what
    // `liveBoardWorld`'s keeper answers, and what this stands in for.
    keeper: (port) => {
      keeperAsks++
      if (!over.kept || port !== PORT) return { kept: false } as Keeper
      if (!booted) return KEPT
      return asksSinceBootout++ < (over.jobGoesAfter ?? 0) ? KEPT : ({ kept: false } as Keeper)
    },
    exec: (call) => {
      calls.push(call.join(' '))
      // The call that *asks* for the termination. What launchd says afterwards
      // is the keeper's above, and it is not `gone` at once.
      if (call[1] === 'bootout' || (call[1] === '--user' && call[2] === 'stop')) booted = true
      return { status: 0, out: '' }
    },
    serve: async () => {},
    open: async () => true,
    signal: (pid) => {
      signalled.push(pid)
      holder = null
      return true
    },
    sleep: async () => {},
    now: () => Date.now(),
    whereThePortIsSet: 'board.port in ~/.lingtai/config.yml, or --port for this one run',
    log: (l) => out.push(l),
    error: (l) => err.push(l),
    ...over,
  }
  const go = (verb: BoardCommand['verb'], extra: Partial<BoardCommand> = {}) =>
    boardCommand({ verb, port: PORT, dir: '/dist/board', open: false, ...extra }, w)
  return { go, out, err, calls, signalled, held: () => holder, keeperAsks: () => keeperAsks }
}

const KEPT: Keeper = {
  kept: true,
  platform: 'launchd',
  path: '/Users/x/Library/LaunchAgents/ai.nextloom.lingtai.board.plist',
  uid: 501,
}

describe('lingtai board start', () => {
  it('serves, prints the URL and says what stops it', async () => {
    const w = world()
    expect(await w.go('start')).toBe(0)
    expect(w.out.join('\n')).toContain(`board on ${URL}`)
    expect(w.out.join('\n')).toContain('ctrl-c stops it')
    expect(w.held()).toBe(`board on ${PORT} pid 500 on mac`)
  })

  it('opens a browser, and says where to look when it could not', async () => {
    const opened: string[] = []
    const w = world({ open: async (url) => (opened.push(url), true) })
    expect(await w.go('start', { open: true })).toBe(0)
    expect(opened).toEqual([URL])

    const none = world({ open: async () => false })
    expect(await none.go('start', { open: true })).toBe(0)
    expect(none.out.join('\n')).toContain(`no browser could be opened here — open ${URL}`)
  })

  it('says a board is already on the port in words, and where the port is set — never a bare EADDRINUSE', async () => {
    const w = world({ holder: `board on ${PORT} pid 41 on mac` })
    expect(await w.go('start')).toBe(1)
    expect(w.err[0]).toBe(`✗ a board is already on ${PORT} — ${URL}`)
    expect(w.err.join('\n')).toContain(`held by board on ${PORT} pid 41 on mac`)
    expect(w.err.join('\n')).toContain('board.port in ~/.lingtai/config.yml')
    expect(w.err.join('\n')).not.toMatch(/EADDRINUSE/)
  })

  it('names a port something that is not a board holds, and serves nothing on it', async () => {
    let served = false
    const w = world({ bound: async () => true, serve: async () => void (served = true) })
    expect(await w.go('start')).toBe(1)
    expect(served).toBe(false)
    expect(w.err.join('\n')).toContain('is held by something that is not a Lingtai board')
    expect(w.err.join('\n')).toContain('board.port in ~/.lingtai/config.yml')
    // The lock is not left behind for a board that never started.
    expect(w.held()).toBeNull()
  })

  it('lets the lock go when the server refuses, so the next start is not refused over it', async () => {
    const w = world({
      serve: async () => {
        throw new Error('no built board at /dist/board/apps/board/server.js')
      },
    })
    expect(await w.go('start')).toBe(1)
    expect(w.held()).toBeNull()
    expect(w.err.join('\n')).toContain('no built board')
  })
})

describe('lingtai board stop', () => {
  it('signals the pid the lock names, and says which it was', async () => {
    const w = world({ holder: `board on ${PORT} pid 500 on mac` })
    expect(await w.go('stop')).toBe(0)
    expect(w.signalled).toEqual([500])
    expect(w.out.join('\n')).toContain(`stopped the board on ${PORT} — pid 500`)
  })

  it("is the supervisor's call where a supervisor keeps the board, and signals nothing itself", async () => {
    // A signal here would be respawned thirty seconds later, behind whatever
    // took the port in the meantime.
    const w = world({ holder: `board on ${PORT} pid 500 on mac`, kept: true })
    expect(await w.go('stop')).toBe(0)
    expect(w.signalled).toEqual([])
    expect(w.calls).toEqual(['launchctl bootout gui/501/ai.nextloom.lingtai.board'])
    expect(w.out.join('\n')).toContain('pnpm lingtai service start')
  })

  /**
   * `bootout` returns while the job is still going (#187).
   *
   * `service.ts`'s `unloadJob` waits past exactly this, and this path did not:
   * it printed *stopped the board's job. It stays stopped* on the call's own
   * exit, and the next command disagreed — `board status` still said `serving
   * board on 17820 pid 500 on mac`, and `board start` was refused by the lock
   * the dying process had not dropped. So the supervisor is asked until it says
   * the job is gone.
   */
  /**
   * `--port`, beside a supervised board on another one (#187).
   *
   * The supervisor's job is `board start --no-open` with no `--port`, so the
   * board it keeps is on this machine's port and no other. Asked without the
   * port at all, `stop` answered *kept* for `--port 18080` beside a supervised
   * board on 17820: it ran `launchctl bootout` on the 17820 job, waited for it
   * to go, and printed *stopped the board's job* — while the board named on
   * the command line was still running and still holding `board:18080`, and
   * the one nobody had named was down until the next `service start`.
   */
  it('stops the board the port names, and boots out no supervised job that is serving another', async () => {
    const w = world({ holder: 'board on 18080 pid 500 on mac', kept: true })
    expect(await w.go('stop', { port: 18080 })).toBe(0)
    expect(w.calls).toEqual([])
    expect(w.signalled).toEqual([500])
    expect(w.out.join('\n')).toContain('stopped the board on 18080 — pid 500')
    expect(w.out.join('\n')).not.toContain("stopped the board's job")
  })

  it('says stopped only once the supervisor says the job is gone, and not when bootout returns', async () => {
    const w = world({ holder: `board on ${PORT} pid 500 on mac`, kept: true, jobGoesAfter: 3 })
    expect(await w.go('stop')).toBe(0)
    expect(w.calls).toEqual(['launchctl bootout gui/501/ai.nextloom.lingtai.board'])
    // Asked before the stop, and then until it had gone — never once.
    expect(w.keeperAsks()).toBeGreaterThan(3)
    expect(w.out.join('\n')).toContain("stopped the board's job")
  })

  it('does not call a job the supervisor still has stopped, however the bootout exited', async () => {
    const w = world({ holder: `board on ${PORT} pid 500 on mac`, kept: true, jobGoesAfter: Infinity })
    expect(await w.go('stop')).toBe(1)
    expect(w.out.join('\n')).not.toContain("stopped the board's job")
    expect(w.err.join('\n')).toContain("the supervisor still has the board's job 60s after the stop")
  })

  it('says a supervisor that could not be asked afterwards, rather than calling the job gone', async () => {
    let asks = 0
    const w = world({
      holder: `board on ${PORT} pid 500 on mac`,
      keeper: () => (asks++ === 0 ? KEPT : { unread: 'launchctl print exited 112' }),
    })
    expect(await w.go('stop')).toBe(1)
    expect(w.calls).toEqual(['launchctl bootout gui/501/ai.nextloom.lingtai.board'])
    expect(w.out.join('\n')).not.toContain("stopped the board's job")
    expect(w.err.join('\n')).toContain('launchctl print exited 112')
  })

  it("stops nothing, and says so, when no board of this machine's is running", async () => {
    const w = world()
    expect(await w.go('stop')).toBe(0)
    expect(w.signalled).toEqual([])
    expect(w.out.join('\n')).toContain('there was nothing to stop')
  })

  it('does not call something answering on the port a board of ours, when no lock names it', async () => {
    const w = world({ answering: async () => URL })
    expect(await w.go('stop')).toBe(0)
    expect(w.signalled).toEqual([])
    expect(w.out.join('\n')).toContain('this signalled nothing, since no lock names it')
  })

  it('signals nothing for a holder on another machine', async () => {
    const w = world({ holder: `board on ${PORT} pid 500 on someone-else` })
    expect(await w.go('stop')).toBe(1)
    expect(w.signalled).toEqual([])
    expect(w.err.join('\n')).toContain('on another machine')
  })

  it('signals nothing when it could not be told whether a supervisor keeps one', async () => {
    const w = world({
      holder: `board on ${PORT} pid 500 on mac`,
      keeper: () => ({ unread: 'launchctl print exited 112' }),
    })
    expect(await w.go('stop')).toBe(1)
    expect(w.signalled).toEqual([])
    expect(w.err.join('\n')).toContain('launchctl print exited 112')
  })

  it('says a board that ignored SIGTERM still holds the lock, and the blunt way out', async () => {
    const w = world({
      holder: `board on ${PORT} pid 500 on mac`,
      // A signal that changes nothing: the holder stays.
      signal: () => true,
    })
    expect(await w.go('stop')).toBe(1)
    expect(w.err.join('\n')).toContain('kill -9 500')
  })
})

describe('lingtai board restart', () => {
  it('is one supervisor call where a supervisor keeps it, never stop-then-start in this terminal', async () => {
    // Stopping the job and starting a board here leaves launchd respawning its
    // own every thirty seconds against a port this terminal holds.
    let served = false
    const w = world({
      holder: `board on ${PORT} pid 500 on mac`,
      keeper: () => KEPT,
      answering: async () => URL,
      serve: async () => void (served = true),
    })
    expect(await w.go('restart')).toBe(0)
    expect(w.calls).toEqual(['launchctl kickstart -k gui/501/ai.nextloom.lingtai.board'])
    expect(served).toBe(false)
    expect(w.out.join('\n')).toContain(`the board answers on ${URL}`)
  })

  it('waits the seconds it says for an answer, though every ask costs its own timeout', async () => {
    // Something that accepts TCP and never replies holds the port: `answering`
    // burns its own five-second timeout every time. Counted in polls alone,
    // the asks a quarter-second apart were far longer than the sentence under
    // them promises.
    let clock = 0
    let asks = 0
    const w = world({
      holder: `board on ${PORT} pid 500 on mac`,
      keeper: () => KEPT,
      answering: async () => ((asks++, (clock += 5_000)), null),
      now: () => clock,
    })
    expect(await w.go('restart')).toBe(1)
    expect(asks).toBe(15)
    expect(clock).toBeLessThanOrEqual(80_000)
    expect(w.err.join('\n')).toContain('75s after the restart')
  })

  /**
   * And the seconds are `service`'s own (#187). A supervised `board restart` is
   * a `launchctl kickstart` of the job that runs `board start`, so what it is
   * waiting for is the Next standalone boot `service install` waits for — and
   * ten seconds of its own made a cold machine, or one with a `pnpm build`
   * running beside it, report failure and exit 1 for a board that bound two
   * seconds later.
   */
  it('gives the board the budget lingtai service gives the same boot, and not one of its own', async () => {
    const w = world({ holder: `board on ${PORT} pid 500 on mac`, keeper: () => KEPT })
    expect(await w.go('restart')).toBe(1)
    expect(w.err.join('\n')).toContain(`${BOARD_WAIT_MS / 1000}s after the restart`)
  })

  it('is stop then start for a port the supervised job is not serving, and kickstarts nothing', async () => {
    // `kickstart -k` on the 17820 job, then 75s of polling 18080 for a board
    // nothing had restarted, then exit 1 (#187).
    let served = 0
    const w = world({ holder: 'board on 18080 pid 500 on mac', kept: true, serve: async () => void served++ })
    expect(await w.go('restart', { port: 18080 })).toBe(0)
    expect(w.calls).toEqual([])
    expect(w.signalled).toEqual([500])
    expect(served).toBe(1)
  })

  it('is stop then start where nothing keeps it', async () => {
    let served = 0
    const w = world({ holder: `board on ${PORT} pid 500 on mac`, serve: async () => void served++ })
    expect(await w.go('restart')).toBe(0)
    expect(w.signalled).toEqual([500])
    expect(served).toBe(1)
  })

  it('starts nothing when the stop failed, rather than a second board beside the first', async () => {
    let served = false
    const w = world({
      holder: `board on ${PORT} pid 500 on someone-else`,
      serve: async () => void (served = true),
    })
    expect(await w.go('restart')).toBe(1)
    expect(served).toBe(false)
  })
})

describe('lingtai board status', () => {
  it('answers three questions and folds none of them into another', async () => {
    const w = world({ holder: `board on ${PORT} pid 500 on mac`, answering: async () => URL, keeper: () => KEPT })
    expect(await w.go('status')).toBe(0)
    const said = w.out.join('\n')
    expect(said).toContain(`serving     board on ${PORT} pid 500 on mac`)
    expect(said).toContain(`answering   answers on ${URL}`)
    expect(said).toContain('supervisor  launchd keeps it')
    expect(said).toContain(`port        ${PORT}, set in board.port`)
  })

  it("says nothing keeps a port the supervised job is not serving, rather than naming that job's plist", async () => {
    const w = world({ holder: 'board on 18080 pid 500 on mac', kept: true })
    expect(await w.go('status', { port: 18080 })).toBe(0)
    const said = w.out.join('\n')
    expect(said).toContain("supervisor  none keeps it — a board here is a terminal's")
    expect(said).not.toContain('board.plist')
    expect(said).toContain('port        18080')
  })

  it('says a board nothing holds the lock for, and a lock that could not be read, apart', async () => {
    const w = world({ answering: async () => URL })
    expect(await w.go('status')).toBe(0)
    expect(w.out.join('\n')).toContain('serving     nobody')
    expect(w.out.join('\n')).toContain(`answering   answers on ${URL}`)

    const unread = world({
      locker: {
        tryLock: async () => ({ ok: false, holder: null }),
        holder: async () => {
          throw new Error('the lock needs node:sqlite')
        },
      },
    })
    expect(await unread.go('status')).toBe(0)
    expect(unread.out.join('\n')).toContain('serving     could not be read — the lock needs node:sqlite')
  })
})

describe('the board lock', () => {
  it('is named for the port, so two boards on two ports are not one lock', () => {
    expect(boardLock(17820)).toBe('board:17820')
    expect(boardLock(18080)).not.toBe(boardLock(17820))
  })

  it('is the key start takes and stop and status read — all three, the same port', async () => {
    const keys: string[] = []
    const locker = {
      tryLock: async (key: string) => (keys.push(key), { ok: true as const, lock: { release: async () => {} } }),
      holder: async (key: string) => (keys.push(key), null),
    }
    const w = world({ locker })
    await w.go('start', { port: 18080 })
    await w.go('stop', { port: 18080 })
    await w.go('status', { port: 18080 })
    expect(keys).toEqual(['board:18080', 'board:18080', 'board:18080'])
  })
})

describe("the lock holder's name", () => {
  it('carries the pid and the host, and nothing is read out of one that does not', () => {
    expect(holdingProcess('board on 17820 pid 500 on mac')).toEqual({ pid: 500, host: 'mac' })
    expect(holdingProcess('a process waiting in line for it')).toBeNull()
  })
})

describe('stopOnSignal (#726)', () => {
  const harness = (release: () => Promise<void>) => {
    const calls: string[] = []
    const exits: number[] = []
    const handle = stopOnSignal({
      release: async () => {
        calls.push('release')
        await release()
      },
      exit: (code) => exits.push(code),
      say: (line) => calls.push(`say ${line.trim()}`),
    })
    return { handle, calls, exits }
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('releases, then exits with the signal code', async () => {
    const h = harness(async () => {})
    h.handle('SIGINT')
    await settle()
    expect(h.calls).toEqual(['say SIGINT: stopped the board', 'release'])
    expect(h.exits).toEqual([130])
    const t = harness(async () => {})
    t.handle('SIGTERM')
    await settle()
    expect(t.exits).toEqual([143])
  })

  it('still exits when the release throws', async () => {
    const h = harness(async () => {
      throw new Error('lock gone')
    })
    h.handle('SIGTERM')
    await settle()
    expect(h.exits).toEqual([143])
  })

  it('a second signal exits at once, without waiting for the first', async () => {
    const h = harness(() => new Promise<void>(() => {}))
    h.handle('SIGINT')
    h.handle('SIGINT')
    expect(h.exits).toEqual([130])
  })
})
