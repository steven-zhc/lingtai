/** `lingtai service status` as a value (#622): every fact the old lines printed, and the one document. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { renderServiceStatus, serviceStatusCode, serviceStatusJson, type ServiceStatus } from '../src/service-status.ts'

const saved = process.env['NO_COLOR']
beforeEach(() => {
  process.env['NO_COLOR'] = '1'
})
afterEach(() => {
  if (saved === undefined) delete process.env['NO_COLOR']
  else process.env['NO_COLOR'] = saved
})

const read: ServiceStatus = {
  platform: 'launchd',
  conductor: {
    target: 'gui/501/ai.nextloom.lingtai.daemon',
    supervisor: { lines: ['state = running', 'pid = 4242'] },
    beacon: 'beating, 3s ago',
  },
  board: {
    target: 'gui/501/ai.nextloom.lingtai.board',
    supervisor: { lines: ['state = spawn scheduled'] },
    url: 'http://127.0.0.1:17820',
    answers: null,
    missing: null,
  },
}

describe('renderServiceStatus', () => {
  it('gives each job its own section and prints the supervisor’s lines as it said them', () => {
    const text = renderServiceStatus(read).join('\n')
    expect(text).toContain('the conductor')
    expect(text).toContain('the board')
    expect(text).toContain('state = running')
    expect(text).toContain('pid = 4242')
    expect(text).toContain('state = spawn scheduled')
    expect(text).toContain('launchctl, gui/501/ai.nextloom.lingtai.daemon')
    expect(text).toContain('beating, 3s ago')
    expect(text).toContain('whether it is beating, which loaded does not say')
    expect(text).toContain('http://127.0.0.1:17820 — whether a board answers there')
    expect(text).toContain('nothing answers')
    expect(text).not.toContain('\u001b')
  })

  it('says a supervisor that could not be asked, never "not loaded"', () => {
    const text = renderServiceStatus({
      ...read,
      conductor: { ...read.conductor, supervisor: { unread: 'launchctl print exited 112' } },
    }).join('\n')
    expect(text).toContain('could not ask — launchctl print exited 112')
  })

  it('says a supervisor that reported nothing about the process', () => {
    const text = renderServiceStatus({ ...read, board: { ...read.board, supervisor: { lines: [] } } }).join('\n')
    expect(text).toContain('loaded, and said nothing about the process')
  })

  it('says a beacon that could not be read', () => {
    const text = renderServiceStatus({
      ...read,
      conductor: { ...read.conductor, beacon: { unread: 'database is down' } },
    }).join('\n')
    expect(text).toContain('could not read it — database is down')
  })

  it('names the three answers of the board', () => {
    const answers = (a: ServiceStatus['board']['answers']): string =>
      renderServiceStatus({ ...read, board: { ...read.board, answers: a } }).join('\n')
    expect(answers('http://127.0.0.1:17820')).toContain('answers on http://127.0.0.1:17820')
    expect(answers(null)).toContain('nothing answers')
    expect(answers({ unread: 'timed out' })).toContain('could not ask — timed out')
  })

  it('says why there is no board job to keep, and what to do', () => {
    const text = renderServiceStatus({
      ...read,
      board: { ...read.board, missing: { why: 'no built board at /x', remedy: ['pnpm build'] } },
    }).join('\n')
    expect(text).toContain('no built board at /x, so this machine has no board job to keep')
    expect(text).toContain('pnpm build')
  })

  it('uses systemctl for systemd', () => {
    const text = renderServiceStatus({ ...read, platform: 'systemd' }).join('\n')
    expect(text).toContain('systemctl --user, gui/501/ai.nextloom.lingtai.daemon')
  })
})

describe('serviceStatusCode', () => {
  it('is 0 when both supervisors were read, and 1 when either was not', () => {
    expect(serviceStatusCode(read)).toBe(0)
    expect(serviceStatusCode({ ...read, board: { ...read.board, supervisor: { unread: 'x' } } })).toBe(1)
    expect(serviceStatusCode({ ...read, conductor: { ...read.conductor, supervisor: { unread: 'x' } } })).toBe(1)
  })
})

describe('serviceStatusJson', () => {
  it('pins the shape', () => {
    expect(serviceStatusJson(read)).toEqual({
      platform: 'launchd',
      conductor: {
        target: 'gui/501/ai.nextloom.lingtai.daemon',
        supervisor: { lines: ['state = running', 'pid = 4242'] },
        beacon: 'beating, 3s ago',
      },
      board: {
        target: 'gui/501/ai.nextloom.lingtai.board',
        supervisor: { lines: ['state = spawn scheduled'] },
        url: 'http://127.0.0.1:17820',
        answers: null,
      },
    })
  })

  it('carries unread answers as {unread} and `missing` only where there is one', () => {
    const doc = serviceStatusJson({
      ...read,
      conductor: {
        ...read.conductor,
        supervisor: { unread: 'launchctl print exited 112' },
        beacon: { unread: 'down' },
      },
      board: {
        ...read.board,
        answers: { unread: 'timed out' },
        missing: { why: 'no built board at /x', remedy: ['pnpm build'] },
      },
    })
    expect(doc).toMatchObject({
      conductor: { supervisor: { unread: 'launchctl print exited 112' }, beacon: { unread: 'down' } },
      board: { answers: { unread: 'timed out' }, missing: { why: 'no built board at /x', remedy: ['pnpm build'] } },
    })
  })
})
