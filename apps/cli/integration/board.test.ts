import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { connect, createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { boardEntry, boardPortOrWhy, builtBoardDir, serveBoard } from '../src/board.ts'

/**
 * `serveBoard` against a stand-in `server.js` that does what Next's does: binds
 * `PORT` on `HOSTNAME` some time after it is loaded, and not before (#183).
 */
const dirs: string[] = []
const servers: Server[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve))
  const g = globalThis as { __boardTestServer?: Server; __boardLoaded?: boolean }
  if (g.__boardTestServer) await new Promise((resolve) => g.__boardTestServer!.close(resolve))
  delete g.__boardTestServer
  delete g.__boardLoaded
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fakeBoard(delayMs: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'lingtai-board-'))
  dirs.push(dir)
  const entry = boardEntry(dir)
  mkdirSync(join(entry, '..'), { recursive: true })
  writeFileSync(
    entry,
    `const net = require("node:net");
globalThis.__boardLoaded = true;
setTimeout(() => {
  globalThis.__boardTestServer = net.createServer((s) => s.end()).listen(Number(process.env.PORT), process.env.HOSTNAME);
}, ${delayMs});
`,
  )
  return dir
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0))
    })
  })
}

function answers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1')
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

describe('serveBoard', () => {
  it('resolves only once the server is listening, not when server.js has loaded', async () => {
    const port = await freePort()
    await serveBoard({ dir: fakeBoard(400), port, host: '127.0.0.1', release: async () => {} })
    expect(await answers(port)).toBe(true)
  })

  it('refuses a port somebody else holds before it loads anything', async () => {
    const port = await freePort()
    const holder = createServer()
    servers.push(holder)
    await new Promise<void>((resolve) => holder.listen(port, '127.0.0.1', resolve))

    await expect(serveBoard({ dir: fakeBoard(0), port, host: '127.0.0.1', release: async () => {} })).rejects.toThrow(
      `127.0.0.1:${port} is already in use`,
    )
    expect((globalThis as { __boardLoaded?: boolean }).__boardLoaded).toBeUndefined()
  })
})

/**
 * Where the built board is found (#187).
 *
 * The one that matters is the second: `lingtai service`'s board job runs
 * `<root>/apps/cli/src/lingtai.ts board start` — from the source, which is the
 * only kind of install `service install` supports — so a `builtBoardDir` that
 * looked only beside itself gave that job nothing to serve, and launchd
 * respawned the corpse every thirty seconds.
 */
describe('builtBoardDir', () => {
  function tree(...entries: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'lingtai-built-'))
    dirs.push(dir)
    for (const entry of entries) {
      const at = boardEntry(join(dir, entry))
      mkdirSync(join(at, '..'), { recursive: true })
      writeFileSync(at, '')
    }
    return dir
  }

  it('is the board beside the running file, which is where a shipped build puts it', () => {
    const dir = tree('board')
    expect(builtBoardDir(join(dir, 'lingtai.cjs'), '/nowhere')).toBe(join(dir, 'board'))
  })

  it('is <root>/dist/board from the source, where pnpm build writes it and nothing is beside apps/cli/src', () => {
    const root = tree(join('dist', 'board'))
    expect(builtBoardDir(join(root, 'apps/cli/src/lingtai.ts'), root)).toBe(join(root, 'dist', 'board'))
  })

  it("prefers the one beside it, so a checkout's stale dist never shadows a shipped build", () => {
    const root = tree('board', join('dist', 'board'))
    expect(builtBoardDir(join(root, 'lingtai.cjs'), root)).toBe(join(root, 'board'))
  })

  it('names the one beside it where neither holds a board, which is what serveBoard then refuses by', () => {
    const root = tree()
    expect(builtBoardDir(join(root, 'apps/cli/src/lingtai.ts'), root)).toBe(join(root, 'apps/cli/src/board'))
  })
})

/**
 * The port, asked for by something whose subject is not the board (#187).
 *
 * `lingtai service` builds a `ServiceOptions` for every verb it has, and
 * `lingtai restart` builds one to delegate through. A `board.port` read there
 * as `boardPort()` threw out of the literal, so `lingtai service shutdown
 * "moving the database"` never entered `serviceCommand`: nothing was drained,
 * nothing was unloaded, and the one thing said was about the board's port.
 */
describe("the board's port, where the board is not the subject", () => {
  function home(yaml: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'lingtai-port-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'config.yml'), yaml)
    return dir
  }

  it("is the file's where the file names one, and the default where nothing does", () => {
    expect(boardPortOrWhy({ LINGTAI_HOME: home('board:\n  port: 18080\n') })).toEqual({ port: 18080 })
    expect(boardPortOrWhy({ LINGTAI_HOME: home('runtime:\n  agent: claude-code\n') })).toEqual({ port: 17820 })
  })

  it('is a reason and never a throw, so a typo in a UI setting does not hold up a drain', () => {
    const asked = boardPortOrWhy({ LINGTAI_HOME: home('board:\n  port: 8o80\n') })
    expect(asked).toEqual({ why: expect.stringContaining('is not a port number') })
    // And the reason does not read as though the default had been used, which
    // is what it would have to have been for the board to be anywhere at all.
    expect((asked as { why: string }).why).toContain('no port was read')
  })
})
