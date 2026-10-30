import { recipeLine } from '@lingtai/conductor/onboard'
import { SQLITE_MACHINE, postgresUrl, githubApp, githubAppKeyMissing, lockDir, renamedNote } from '@lingtai/env'
import { describe, expect, it } from 'vitest'

import {
  BOARD_START_NOTE,
  BOARD_STOPPED_NOTE,
  noAnswerNote,
  stillAnsweringNote,
  supervisorRefusal,
} from '../src/board.js'
import {
  DEFERRED,
  GITHUB_APP_NOT_CONFIGURED,
  STORE_UNWRITTEN,
  notSessionModeDetail,
  postgresOnlyRows,
} from '../src/doctor.js'
import { noOriginRefusal } from '../src/first-project.js'
import { exportedUrlRefusal, sqliteEditSentence, sqliteExportedRefusal } from '../src/init.js'
import { dollarCeilingNote } from '../src/landing.js'
import { DIFFERENT_SOURCE_CLASH } from '../src/source.js'

/**
 * What `init`, `add` and `doctor` print to a user must not cite an ADR, an
 * issue or a source path — those describe Lingtai's internals, not the user's
 * situation (#703). This holds the listed strings only; code comments keep
 * their references, and the guard reads output strings alone. A `pnpm`-prefixed
 * command is refused too: a binary install has no `pnpm`.
 */

function thrown(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    return (e as Error).message
  }
  throw new Error('expected a throw')
}

export function references(text: string): string[] {
  const patterns = [
    /\b0\d{3}( §\d+)?\b/g,
    /(?<![\w/])#\d{2,}\b/g,
    /(?<![\w./:])(packages|apps|doc)\/[\w./-]+\.(ts|md)\b/g,
    /\bpnpm lingtai\b/g,
  ]
  return patterns.flatMap((p) => [...text.matchAll(p)].map((m) => m[0]))
}

const SET: [string, string][] = [
  ['SQLITE_MACHINE', SQLITE_MACHINE],
  ['renamedNote', renamedNote('DATABASE_URL', 'LINGTAI_DATABASE_URL')],
  ['githubAppKeyMissing (environment)', githubAppKeyMissing('environment')],
  ['githubAppKeyMissing (file)', githubAppKeyMissing('~/.lingtai/config.yml')],
  ['lockDir unset', thrown(() => lockDir({ VITEST: 'true', HOME: '/h' }))],
  ['githubApp renamed', thrown(() => githubApp({ GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: 'k', HOME: '/h' }))],
  ['postgresUrl test side', thrown(() => postgresUrl({ VITEST: 'true', DATABASE_URL: 'x', HOME: '/h' }))],
  ['exportedUrlRefusal', exportedUrlRefusal('--database-url', 'postgres://a', 'LINGTAI_DATABASE_URL', 'postgres://b')],
  ['sqliteEditSentence', sqliteEditSentence('/h/config.yml')],
  ['sqliteExportedRefusal', sqliteExportedRefusal('LINGTAI_DATABASE_URL is exported')],
  ['noOriginRefusal', noOriginRefusal('/repo', 'fatal: no such remote', 'Nothing was written.')],
  ['dollarCeilingNote (named)', dollarCeilingNote('codex')],
  ['dollarCeilingNote (unnamed)', dollarCeilingNote(null)],
  ['DIFFERENT_SOURCE_CLASH', DIFFERENT_SOURCE_CLASH],
  ['GITHUB_APP_NOT_CONFIGURED', GITHUB_APP_NOT_CONFIGURED],
  ['recipeLine', recipeLine('/h/.lingtai/x/recipe.yml')],
  ['STORE_UNWRITTEN', STORE_UNWRITTEN],
  ['notSessionModeDetail (stand-in)', notSessionModeDetail(true)],
  ['notSessionModeDetail (direct)', notSessionModeDetail(false)],
  ['BOARD_START_NOTE', BOARD_START_NOTE],
  ['supervisorRefusal', supervisorRefusal('stop')],
  ['BOARD_STOPPED_NOTE', BOARD_STOPPED_NOTE],
  ['stillAnsweringNote', stillAnsweringNote(10)],
  ['noAnswerNote', noAnswerNote('http://localhost:1', 10)],
  ...DEFERRED.map((d): [string, string] => [`doctor deferred: ${d.name}`, d.detail]),
  ...postgresOnlyRows().map((r): [string, string] => [`doctor skip: ${r.name}`, r.because]),
]

describe('the strings init, add and doctor print', () => {
  it('the set is not empty, and every entry is a non-empty string', () => {
    expect(SET.length).toBeGreaterThan(15)
    for (const [label, text] of SET) {
      expect(typeof text, label).toBe('string')
      expect(text.length, label).toBeGreaterThan(0)
    }
  })

  it('carry no ADR, issue or source-path reference', () => {
    for (const [label, text] of SET) expect(references(text), label).toEqual([])
  })

  it('the guard itself sees a reference, and lets a URL through', () => {
    expect(references('a new log (0055 §3)')).not.toEqual([])
    expect(references('same streams (#381)')).not.toEqual([])
    expect(references('see packages/x.ts')).not.toEqual([])
    expect(references('db ticket #12')).not.toEqual([])
    expect(references('under lingtai service it is a job: pnpm lingtai board stop')).toEqual(['pnpm lingtai'])
    expect(references('run lingtai board stop')).toEqual([])
    expect(references('https://github.com/apps/lingtai/installations/new')).toEqual([])
    expect(references('https://github.com/settings/apps/lingtai')).toEqual([])
  })
})
