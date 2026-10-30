import { spawn, spawnSync } from 'node:child_process'
import { connect } from 'node:net'
import { hostname } from 'node:os'

import { boardPort } from '@lingtai/env'
import { createFileLocker } from '@lingtai/env/lock'

import { boardAt, serveBoard, type BoardWorld } from './board.ts'
import { configPath } from './init.ts'
import { BOARD_JOB, keeper } from './service.ts'

/**
 * The board's lifecycle against this machine (#187): its lock, its supervisor,
 * its port. Here and not in `lingtai.ts` because `cli.ts` loads it, and importing
 * `lingtai.ts` runs `main`.
 */
export function liveBoardWorld(): BoardWorld {
  return {
    host: '127.0.0.1',
    hostname: hostname(),
    answering: boardAt,
    bound: (port) =>
      new Promise<boolean>((resolve) => {
        const socket = connect(port, '127.0.0.1')
        socket.once('connect', () => {
          socket.destroy()
          resolve(true)
        })
        socket.once('error', () => resolve(false))
      }),
    locker: createFileLocker(),
    // The supervisor's job is `lingtai board start --no-open` with no `--port`
    // (`BOARD_JOB.argv`), so the board it keeps is on `boardPort()` and on no
    // other. A `--port` that names a different one is a board of this
    // terminal's, and the supervisor keeps nothing there — asked without the
    // port, `board stop --port 18080` booted out the job serving 17820 and
    // reported that as the stop of the board it was given (#187). A port that
    // could not be read at all is one no job is serving either.
    keeper: (port) => {
      let supervised: number
      try {
        supervised = boardPort()
      } catch {
        return { kept: false }
      }
      return port === supervised ? keeper({}, BOARD_JOB) : { kept: false }
    },
    exec: (call) => {
      const r = spawnSync(call[0]!, call.slice(1), { encoding: 'utf8' })
      if (r.error) return { status: 127, out: r.error.message }
      return { status: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
    },
    serve: serveBoard,
    open: (url) =>
      new Promise((resolve) => {
        const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
        const child = spawn(opener, [url], { stdio: 'ignore', detached: true })
        child.once('error', () => resolve(false))
        child.once('spawn', () => {
          child.unref()
          resolve(true)
        })
      }),
    // `kill` with no signal would only ask whether it exists; SIGTERM is the
    // stop, and the handler a board installs releases the lock and exits.
    signal: (pid) => {
      try {
        process.kill(pid, 'SIGTERM')
        return true
      } catch {
        return false
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    whereThePortIsSet: `board.port in ${configPath(process.env)}, or --port for this one run`,
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  }
}
