/** `lingtai board` through `@effect/cli` (#623): the arguments, `board status`'s layout, and its `--json`. */
import { readFileSync } from 'node:fs'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { boardStatusJson, renderBoardStatus, type BoardStatus } from '../src/board.ts'
import { runCli, type BoardRequest } from '../src/cli.ts'
import { BOARD_JOB } from '../src/service.ts'

async function capture(
  args: string[],
  board: (request: BoardRequest) => Promise<number> = async () => 0,
): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((t: string | Uint8Array) => ((out += String(t)), true))
  vi.spyOn(process.stderr, 'write').mockImplementation((t: string | Uint8Array) => ((err += String(t)), true))
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void (out += `${a.join(' ')}\n`))
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void (err += `${a.join(' ')}\n`))
  const code = await runCli(['node', 'lingtai', 'board', ...args], { board })
  return { code, out, err }
}

const saved = process.env['NO_COLOR']
beforeEach(() => {
  process.env['NO_COLOR'] = '1'
})
afterEach(() => {
  vi.restoreAllMocks()
  if (saved === undefined) delete process.env['NO_COLOR']
  else process.env['NO_COLOR'] = saved
})

const PATH = '/Users/x/Library/LaunchAgents/ai.nextloom.lingtai.board.plist'
const WHERE = 'board.port in ~/.lingtai/config.yml, or --port for this one run'
const status = (over: Partial<BoardStatus> = {}): BoardStatus => ({
  port: 17820,
  url: 'http://127.0.0.1:17820',
  portSetIn: WHERE,
  serving: { holder: 'board on 17820 pid 500 on mac' },
  answering: { url: 'http://127.0.0.1:17820' },
  supervisor: { kept: true, platform: 'launchd', path: PATH, uid: 501 },
  ...over,
})

describe('lingtai board, the arguments', () => {
  it('is start when no verb is named, as it was before it had verbs', async () => {
    const seen: BoardRequest[] = []
    const run = async (r: BoardRequest) => (seen.push(r), 0)
    expect((await capture([], run)).code).toBe(0)
    await capture(['--port', '18080', '--no-open'], run)
    await capture(['start', '--dir', '/x'], run)
    expect(seen).toEqual([
      { verb: 'start', port: null, dir: null, open: true, json: false },
      { verb: 'start', port: 18080, dir: null, open: false, json: false },
      { verb: 'start', port: null, dir: '/x', open: true, json: false },
    ])
  })

  it('reads each verb, and `stop`, `restart` and `status` take --port', async () => {
    const seen: BoardRequest[] = []
    const run = async (r: BoardRequest) => (seen.push(r), 0)
    await capture(['stop', '--port', '18080'], run)
    await capture(['restart', '--no-open'], run)
    await capture(['status', '--port', '18080', '--json'], run)
    expect(seen.map((r) => [r.verb, r.port, r.open, r.json])).toEqual([
      ['stop', 18080, true, false],
      ['restart', null, false, false],
      ['status', 18080, true, true],
    ])
  })

  it('answers `shutdown` by name with the verb that is not it, and why, and exits 2', async () => {
    const r = await capture(['shutdown'])
    expect(r.code).toBe(2)
    expect(r.err).toContain('lingtai board stop')
    expect(r.err).toContain('no pass to finish')
    const asJson = await capture(['shutdown', '--json'])
    expect(asJson.code).toBe(2)
    expect(JSON.parse(asJson.out)).toMatchObject({ command: 'board', error: { code: 'usage' } })
  })

  it.each(['no', '99999', '0'])('refuses a port that is not one (%s), and runs nothing', async (port) => {
    let ran = false
    const r = await capture(['start', '--port', port], async () => ((ran = true), 0))
    expect(r.code === 2 || r.code === 1).toBe(true)
    expect(ran).toBe(false)
  })

  it('names --port takes a port number for an out-of-range integer, exit 2', async () => {
    const r = await capture(['start', '--port', '99999'])
    expect(r.code).toBe(2)
    expect(r.err).toContain('--port takes a port number')
  })

  it('gives `--json` to status alone', async () => {
    expect((await capture(['stop', '--json'])).code).toBe(1)
  })
})

describe('the supervisor reaches board through lingtai.ts', () => {
  it("serves the job's command from a real case, not the entry's refusal group", () => {
    expect(BOARD_JOB.argv.slice(0, 2)).toEqual(['board', 'start'])
    const source = readFileSync(new URL('../src/lingtai.ts', import.meta.url), 'utf8')
    const body = /case 'board':\n([\s\S]*?)\n\s*case 'start':/.exec(source)?.[1] ?? ''
    expect(body).toContain('runCli')
    expect(body).not.toContain('runs from the entry')
    // And it is not also in the group that answers "runs from the entry" with 2.
    const refusal = source.slice(source.indexOf("case 'init':"), source.indexOf('runs from the entry'))
    expect(refusal).not.toContain("case 'board'")
  })
})

describe('renderBoardStatus', () => {
  it('prints a heading and the four rows in one column, plain', () => {
    expect(renderBoardStatus(status())).toEqual([
      'board on 17820',
      '  serving     board on 17820 pid 500 on mac',
      '  answering   answers on http://127.0.0.1:17820',
      `  supervisor  launchd keeps it (${PATH})`,
      `  port        17820, set in ${WHERE}`,
    ])
  })

  it('says each fact’s other branches', () => {
    const lines = renderBoardStatus(
      status({ serving: { holder: null }, answering: { url: null }, supervisor: { kept: false } }),
    ).join('\n')
    expect(lines).toContain("serving     nobody — no board of this machine's holds the lock")
    expect(lines).toContain('answering   nothing answers on http://127.0.0.1:17820')
    expect(lines).toContain("supervisor  none keeps it — a board here is a terminal's")
  })

  it('says a fact that could not be read, without failing the others', () => {
    const lines = renderBoardStatus(
      status({
        serving: { unread: 'no sqlite' },
        answering: { unread: 'timed out' },
        supervisor: { unread: 'bad plist' },
      }),
    ).join('\n')
    expect(lines).toContain('serving     could not be read — no sqlite')
    expect(lines).toContain('answering   could not be asked — timed out')
    expect(lines).toContain('supervisor  bad plist')
  })
})

describe('boardStatusJson', () => {
  it('pins the shape of a board that is up', () => {
    expect(boardStatusJson(status())).toEqual({
      serving: { holder: 'board on 17820 pid 500 on mac', pid: 500, host: 'mac' },
      answering: { url: 'http://127.0.0.1:17820' },
      supervisor: { kept: true, platform: 'launchd', path: PATH },
      port: 17820,
      portSetIn: WHERE,
    })
  })

  it('has a key for nothing holding, nothing answering and nothing keeping it', () => {
    expect(
      boardStatusJson(status({ serving: { holder: null }, answering: { url: null }, supervisor: { kept: false } })),
    ).toMatchObject({ serving: { holder: null }, answering: { url: null }, supervisor: { kept: false } })
  })

  it('carries an unread fact in its own key, and a holder that names no pid without one', () => {
    expect(
      boardStatusJson(status({ serving: { unread: 'a' }, answering: { unread: 'b' }, supervisor: { unread: 'c' } })),
    ).toMatchObject({ serving: { unread: 'a' }, answering: { unread: 'b' }, supervisor: { unread: 'c' } })
    expect(boardStatusJson(status({ serving: { holder: 'someone waiting' } }))['serving']).toEqual({
      holder: 'someone waiting',
    })
  })

  it('is the one document `board status --json` prints, parsed from stdout', async () => {
    const { printJson } = await import('../src/output.ts')
    let out = ''
    printJson('board status', boardStatusJson(status()), { write: (t: string) => ((out += t), true) })
    expect(JSON.parse(out)).toMatchObject({ version: 1, command: 'board status', port: 17820 })
  })
})
