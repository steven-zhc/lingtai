import { expect, it } from 'vitest'

import { boardOrigin, boardReachHost, machineBoardHost, machineFileFrom } from '../src/index.ts'

const file = (text: string | null) => machineFileFrom('/h/config.yml', text)

it('is absent where nothing names it, the file where it does, and the variable over the file', () => {
  expect(machineBoardHost({}, file(null))).toBeUndefined()
  expect(machineBoardHost({}, file('board:\n  host: 192.168.1.5\n'))).toBe('192.168.1.5')
  expect(machineBoardHost({ LINGTAI_BOARD_HOST: '::' }, file('board:\n  host: 192.168.1.5\n'))).toBe('::')
})

it.each([
  [{ LINGTAI_BOARD_HOST: 'localhost' }, file(null), 'LINGTAI_BOARD_HOST'],
  [{ LINGTAI_BOARD_HOST: '' }, file(null), 'LINGTAI_BOARD_HOST'],
  [{}, file('board:\n  host: "1.2.3.4:5"\n'), 'board.host'],
  [{}, file('board:\n  host: localhost\n'), 'board.host'],
  [{ LINGTAI_BOARD_HOST: 'fe80::1%en0' }, file(null), 'LINGTAI_BOARD_HOST'],
  [{}, file('board:\n  host: "fe80::1%en0"\n'), 'board.host'],
])('refuses a value that is not an IP literal by name', (from, written, name) => {
  expect(() => machineBoardHost(from, written)).toThrow(name)
})

it('reaches a wildcard at loopback and a specific address at itself', () => {
  expect(boardReachHost('0.0.0.0')).toBe('127.0.0.1')
  expect(boardReachHost('::')).toBe('::1')
  expect(boardReachHost('192.168.1.5')).toBe('192.168.1.5')
})

it('brackets an IPv6 host in a URL', () => {
  expect(boardOrigin('::1', 17820)).toBe('http://[::1]:17820')
  expect(boardOrigin('127.0.0.1', 17820)).toBe('http://127.0.0.1:17820')
})
