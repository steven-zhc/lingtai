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
  it('quotes a path or label with spaces so the copied command means what it says', () => {
    expect(hereSteps({ kind: 'unregistered', toplevel: '/work/My Projects/widgets' }).steps[0]!.command).toBe(
      "lingtai add --local '/work/My Projects/widgets'",
    )
    expect(addSteps({ project: 'w', tickets: 'github', kinds: ['tech debt'], slug: 'acme/w' })[0]!.command).toBe(
      "gh issue create -R acme/w --label 'tech debt'",
    )
    expect(addSteps({ project: 'my p', tickets: 'db', kinds: [], slug: null })[1]!.command).toBe(
      "lingtai ticket new --project 'my p'",
    )
  })
})

describe("the first ticket takes the queue's own rule and the repository's form (#1518)", () => {
  const base = { project: 'w', tickets: 'github', kinds: ['bug', 'feature'], slug: 'acme/w' } as const
  const command = (extra: object) => addSteps({ ...base, ...extra })[0]!.command
  const mine = { take: 'mine', login: 'sam' } as const

  it("team mode (always mine): the recipe's login", () => {
    expect(command({ takes: mine })).toBe('gh issue create -R acme/w --label bug --assignee sam')
  })
  it('solo take: mine is the same', () => {
    expect(command({ takes: { take: 'mine', login: 'steven-zhc' } })).toBe(
      'gh issue create -R acme/w --label bug --assignee steven-zhc',
    )
  })
  it('solo take: all and take: unassigned assign nobody', () => {
    expect(command({ takes: { take: 'all', login: 'sam' } })).toBe('gh issue create -R acme/w --label bug')
    expect(command({ takes: { take: 'unassigned', login: 'sam' } })).toBe('gh issue create -R acme/w --label bug')
  })
  it('team with no login writes @me', () => {
    expect(command({ takes: { take: 'mine', login: null } })).toBe(
      'gh issue create -R acme/w --label bug --assignee @me',
    )
  })
  it('one form: opens it by file, assigned, quoted so & does not background it', () => {
    const forms = { kind: 'one', file: 'new-joke.yml', name: 'New joke' } as const
    const [step] = addSteps({ ...base, takes: mine, forms })
    expect(step!.command).toBe("open 'https://github.com/acme/w/issues/new?template=new-joke.yml&assignees=sam'")
    expect(step!.for).toContain('"New joke"')
    expect(step!.command).not.toContain('--label')
    expect(command({ takes: { take: 'all', login: null }, forms })).toBe(
      "open 'https://github.com/acme/w/issues/new?template=new-joke.yml'",
    )
  })
  it('one form under take: unassigned never names an assignee', () => {
    const forms = { kind: 'one', file: 'f.yml', name: 'F' } as const
    expect(command({ takes: { take: 'unassigned', login: 'sam' }, forms })).not.toContain('assignees')
  })
  it('several forms: the chooser, and who to assign when it is mine', () => {
    const forms = { kind: 'several' } as const
    expect(addSteps({ ...base, takes: mine, forms })[0]).toEqual({
      command: 'open https://github.com/acme/w/issues/new/choose',
      for: 'its first ticket, from one of its forms, then assign it to sam',
    })
    expect(addSteps({ ...base, forms })[0]!.for).toBe('its first ticket, from one of its forms')
  })
  it('team with no login and a form falls back to the gh line', () => {
    expect(command({ takes: { take: 'mine', login: null }, forms: { kind: 'several' } })).toBe(
      'gh issue create -R acme/w --label bug --assignee @me',
    )
  })
  it('here: a registered checkout follows the same rule', () => {
    expect(hereSteps({ kind: 'registered', ...base, takes: mine, forms: { kind: 'none' } }).steps[0]!.command).toBe(
      'gh issue create -R acme/w --label bug --assignee sam',
    )
  })
  it('local tickets are untouched', () => {
    expect(addSteps({ project: 'p', tickets: 'db', kinds: [], slug: null, takes: mine })[1]!.command).toBe(
      'lingtai ticket new --project p',
    )
  })
})
