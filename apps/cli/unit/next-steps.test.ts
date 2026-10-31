import { describe, expect, it } from 'vitest'

import { addSteps, githubInitSteps, hereSteps, localInitSteps } from '../src/next-steps.ts'

describe('the steps each path closes on (0121 §1, #756)', () => {
  it('local init, no board running', () => {
    expect(localInitSteps(true)).toEqual([
      { command: 'lingtai board', for: 'the board, leave it running' },
      { command: 'lingtai ticket new', for: 'your first ticket, in another terminal' },
      { command: 'lingtai start', for: 'takes it, leave it running' },
    ])
  })
  it('local init, a board already running', () => {
    expect(localInitSteps(false)).toEqual([
      { command: 'lingtai ticket new', for: 'your first ticket' },
      { command: 'lingtai start', for: 'takes it, leave it running' },
    ])
  })
  it('github init', () => {
    expect(githubInitSteps()).toEqual([
      { command: 'lingtai add <owner>/<repo>', for: 'the repository Lingtai works on' },
    ])
  })
  it('github init, App just made', () => {
    expect(githubInitSteps('http://x/setup/repository').map((s) => s.command)).toEqual([
      'open http://x/setup/repository',
      'lingtai add <owner>/<repo>',
    ])
  })
  it('add, tickets in the db', () => {
    expect(addSteps({ project: 'p', tickets: 'db', kinds: ['bug'], slug: null }).map((s) => s.command)).toEqual([
      'lingtai board',
      'lingtai ticket new --project p',
      'lingtai start',
    ])
  })
  it('add, tickets on github: gh issue create with the first kind, never ticket new', () => {
    const steps = addSteps({ project: 'w', tickets: 'github', kinds: ['bug', 'feature'], slug: 'acme/w' })
    expect(steps.map((s) => s.command)).toEqual(['gh issue create -R acme/w --label bug', 'lingtai start'])
    expect(steps[0]!.for).toContain('with a kind label')
  })
  it('add, tickets on github with no kinds: no --label', () => {
    expect(addSteps({ project: 'w', tickets: 'github', kinds: [], slug: 'acme/w' })[0]!.command).toBe(
      'gh issue create -R acme/w',
    )
  })
  it('here: an unregistered repository names add --local with the absolute path', () => {
    expect(hereSteps({ kind: 'unregistered', toplevel: '/abs/clone' })).toEqual({
      preface: '/abs/clone is not a project here',
      steps: [{ command: 'lingtai add --local /abs/clone', for: 'registers it' }],
    })
  })
  it('here: a registered project', () => {
    expect(
      hereSteps({ kind: 'registered', project: 'p', tickets: 'db', kinds: [], slug: null }).steps.map((s) => s.command),
    ).toEqual(['lingtai ticket new --project p', 'lingtai start'])
    expect(
      hereSteps({ kind: 'registered', project: 'p', tickets: 'github', kinds: ['bug'], slug: 'a/p' }).steps.map(
        (s) => s.command,
      ),
    ).toEqual(['gh issue create -R a/p --label bug', 'lingtai start'])
  })
  it('here: an unreadable recipe leaves the ticket line out', () => {
    expect(
      hereSteps({ kind: 'registered', project: 'p', tickets: null, kinds: [], slug: null }).steps.map((s) => s.command),
    ).toEqual(['lingtai start'])
  })
  it('here: outside a repository', () => {
    expect(hereSteps({ kind: 'outside' }).steps.map((s) => s.command)).toEqual(['lingtai add'])
  })
})
