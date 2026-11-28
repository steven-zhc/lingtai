import { prStream } from '@lingtai/domain'
import { ProjectFiles } from '@lingtai/project'
import { resolveSource } from '@lingtai/recipe'
import * as setup from '@lingtai/setup'
import { Effect, Fiber } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { addFlowEffect } from '../src/add.ts'
import { chooseFirstProjectEffect } from '../src/first-project.ts'
import { initCommandEffect } from '../src/init.ts'
import { flagsFromArgv } from '../test/flags.ts'
import { setupWorld, HOME, PATH, projectState } from '../test/local-setup-world.ts'

type World = ReturnType<typeof setupWorld>
const runInit = (w: World, args = ['--local', '/repo', '--mode', 'solo']) =>
  Effect.runPromise(initCommandEffect(flagsFromArgv(args), w.init).pipe(Effect.provideService(ProjectFiles, w.files)))
const runAdd = (w: World, args = ['--local', '/repo', '--mode', 'solo']) =>
  Effect.runPromise(addFlowEffect(flagsFromArgv(args), w.add).pipe(Effect.provideService(ProjectFiles, w.files)))
const runLocal = (w: World, flags: Record<string, string> = { local: '/repo', mode: 'solo' }) =>
  Effect.runPromise(chooseFirstProjectEffect(w.project, flags).pipe(Effect.provideService(ProjectFiles, w.files)))
const shape = (entries: readonly setup.Entry[]) => entries.map((e) => [e.id, e.asked])
let walks: setup.Entry[][] = []
let observe = (_entries: readonly setup.Entry[]) => {}

beforeEach(() => {
  vi.stubEnv('LINGTAI_HOME', HOME)
  walks = []
  observe = () => {}
  const original = setup.runSetupList
  vi.spyOn(setup, 'runSetupList').mockImplementation(((...args: Parameters<typeof original>) =>
    original(...args).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          if (result.entries[0]?.id === 'where') {
            walks.push([...result.entries])
            observe(result.entries)
          }
        }),
      ),
    )) as typeof original)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('init and add use the same project list (#1526)', () => {
  it('init --local finishes all entries before setting the recipe, making lingtai-base or registering', () => {
    const w = setupWorld()
    observe = (entries) => {
      expect(entries.map((e) => e.id)).toEqual(setup.PROJECT_QUESTION_IDS)
      w.events.push('list-finished')
    }
    return runInit(w).then((code) => {
      expect(code, w.logged.join('\n')).toBe(0)
      expect(walks).toHaveLength(1)
      const asked = new Set([
        'branch',
        'defaults',
        'writer',
        'writer-model',
        'reviewer',
        'reviewer-model',
        'install',
        'checks',
        'kinds',
        'landing',
        'refusal-fixes',
        'conflict-resolutions',
        'wall',
        'budget',
      ])
      expect(shape(walks[0]!)).toEqual(setup.PROJECT_QUESTION_IDS.map((id) => [id, asked.has(id)]))
      expect(w.events.filter((e) => !e.startsWith('ask:'))).toEqual([
        'list-finished',
        'branch:lingtai-base',
        'recipe',
        'register',
      ])
      expect(w.writes).toHaveLength(1)
      expect(w.branches.has('lingtai-base')).toBe(true)
      expect(w.registered).toHaveLength(1)
    })
  })

  it('init --local and add --local produce equal entry ids and asked flags over the same fake world', () => {
    const w = setupWorld()
    return runInit(w)
      .then((code) => {
        expect(code, w.logged.join('\n')).toBe(0)
        w.recipes.clear()
        w.branches.delete('lingtai-base')
        return runAdd(w)
      })
      .then((code) => {
        expect(code, w.logged.join('\n')).toBe(0)
        expect(walks).toHaveLength(2)
        expect(shape(walks[0]!)).toEqual(shape(walks[1]!))
      })
  })

  it('init --github and add owner/repo produce equal entry ids and asked flags over the same fake world', () => {
    const w = setupWorld()
    return runInit(w, ['--github', 'acme/repo', '--mode', 'solo'])
      .then((code) => {
        expect(code, w.logged.join('\n')).toBe(0)
        w.recipes.clear()
        return runAdd(w, ['acme/repo', '--mode', 'solo'])
      })
      .then((code) => {
        expect(code, w.logged.join('\n')).toBe(0)
        expect(walks).toHaveLength(2)
        expect(shape(walks[0]!)).toEqual(shape(walks[1]!))
      })
  })

  it('interruption at kinds leaves no recipe, branch or registration and keeps machine answers', () => {
    const w = setupWorld()
    let reached = () => {}
    const atKinds = new Promise<void>((resolve) => {
      reached = resolve
    })
    const ask = w.init.ask
    w.init.ask = (prompt, opts) => {
      if (/which labels are work/.test(prompt)) {
        reached()
        return new Promise(() => {})
      }
      return ask(prompt, opts)
    }
    const fiber = Effect.runFork(
      initCommandEffect(flagsFromArgv(['--local', '/repo', '--mode', 'solo']), w.init).pipe(
        Effect.provideService(ProjectFiles, w.files),
      ),
    )
    return atKinds
      .then(() => Effect.runPromise(Fiber.interrupt(fiber)))
      .then(() => {
        expect(w.recipes.size).toBe(0)
        expect(w.writes).toEqual([])
        expect(w.branches.has('lingtai-base')).toBe(false)
        expect(w.registered).toEqual([])
        expect(w.machineFiles.get(`${HOME}/config.yml`)).toContain('sqlite')
      })
  })

  it('an interrupted rerun discards its answers too', () => {
    const first = setupWorld()
    return runInit(first).then(() => {
      const original = first.recipes.get(PATH)!
      const w = setupWorld({ text: original, projects: [projectState()] })
      w.branches.set('lingtai-base', 'abc123f')
      let reached = () => {}
      const atKinds = new Promise<void>((resolve) => {
        reached = resolve
      })
      w.init.ask = (prompt) => {
        if (/which labels are work/.test(prompt)) {
          reached()
          return new Promise(() => {})
        }
        return Promise.resolve(/use every default/.test(prompt) ? 'no' : '')
      }
      const fiber = Effect.runFork(
        initCommandEffect(flagsFromArgv(['--local', '/repo', '--mode', 'solo', '--model', 'custom']), w.init).pipe(
          Effect.provideService(ProjectFiles, w.files),
        ),
      )
      return atKinds
        .then(() => Effect.runPromise(Fiber.interrupt(fiber)))
        .then(() => {
          expect(w.recipes.get(PATH)).toBe(original)
          expect(w.writes).toEqual([])
          expect(w.registered).toEqual([])
        })
    })
  })

  it('repair from another checkout asks the whole list and taking the defaults writes only the move', () => {
    const first = setupWorld()
    return runInit(first).then(() => {
      const old = first.recipes.get(PATH)!.replace('remote: /repo', 'remote: /old/repo')
      const w = setupWorld({ text: old, projects: [projectState()], origin: '/old/repo' })
      w.branches.set('lingtai-base', 'abc123f')
      const ask = w.init.ask
      w.init.ask = (prompt, opts) => (/Move repo's landing/.test(prompt) ? Promise.resolve('yes') : ask(prompt, opts))
      return runInit(w).then((code) => {
        expect(code, w.logged.join('\n')).toBe(0)
        const repair = walks.at(-1)!
        expect(repair.map((e) => e.id)).toEqual(setup.PROJECT_QUESTION_IDS)
        expect(repair.filter((e) => e.asked).map((e) => e.id)).toContain('move-landing')
        expect(repair.filter((e) => e.asked).map((e) => e.id)).toContain('kinds')
        expect(w.writes).toEqual([old.replace('remote: /old/repo', 'remote: /repo')])
        expect(w.events.filter((e) => !e.startsWith('ask:'))).toEqual(['mirror', 'recipe', 'register'])
      })
    })
  })

  it('a repair trial uses the new checkout commits, removing the old mirror once before provisioning', () => {
    const first = setupWorld()
    return runInit(first).then(() => {
      const old = first.recipes.get(PATH)!.replace('remote: /repo', 'remote: /old/repo')
      const w = setupWorld({ text: old, projects: [projectState()], origin: '/old/repo' })
      w.branches.set('lingtai-base', 'new222')
      const git = w.project.git
      w.project.git = (dir, args) =>
        args.join(' ') === 'rev-parse --show-toplevel'
          ? Effect.succeed({ ok: true, stdout: '/new/repo', stderr: '' })
          : git(dir, args)
      w.project.ask = (prompt) =>
        Promise.resolve(
          /Move repo's landing/.test(prompt) ? 'yes' : /keep the list as it is/.test(prompt) ? 'keep' : '',
        )
      let mirrorOrigin: string | undefined = '/old/repo'
      w.project.removeMirror = () =>
        Effect.sync(() => {
          w.events.push('mirror')
          mirrorOrigin = undefined
        })
      // Provisioning fetches an existing mirror's origin; the supplied remote is used only on clone.
      const deps: setup.TrialDeps = {
        provision: (at) =>
          Effect.sync(() => {
            mirrorOrigin ??= at.remote
            const sha = mirrorOrigin === '/new/repo' ? 'new222' : 'old111'
            w.events.push(`provision:${at.base}:${sha}`)
            return { path: `/trial/${sha}` }
          }),
        run: (at) =>
          Effect.sync(() => {
            const passed = at.cwd === '/trial/old111'
            w.events.push(`trial:${passed ? 'passed' : 'failed'}`)
            return {
              ok: passed,
              exitCode: passed ? 0 : 1,
              evidence: passed ? '' : 'new commits fail',
              timedOut: false,
              durationMs: 0,
            }
          }),
        remove: () => Effect.void,
        resolveEnv: () => Promise.resolve({ values: {} }),
        runId: () => 'repair-trial',
        log: () => {},
      }
      vi.spyOn(setup, 'liveTrialBuild').mockImplementation((at) => ({
        base: setup.trialBaseEffect(at),
        run: (install, build) => setup.runTrialEffect(at, deps, install, build),
      }))
      return Effect.runPromise(
        chooseFirstProjectEffect(w.project, { local: '/new/repo', defaults: '', 'check-build': 'yes' }, [
          'pnpm test',
        ]).pipe(Effect.provideService(ProjectFiles, w.files)),
      ).then((result) => {
        expect(result, w.logged.join('\n')).toMatchObject({ ok: true, trial: { trial: 'failed-kept' } })
        expect(w.events).toEqual(['mirror', 'provision:lingtai-base:new222', 'trial:failed', 'recipe', 'register'])
        expect(mirrorOrigin).toBe('/new/repo')
        expect(w.registered[0]).toMatchObject({ base: 'lingtai-base', fromSha: 'new222' })
        expect(w.recipes.get(PATH)).toContain('remote: /new/repo')
      })
    })
  })

  it.each(['mode', 'login', 'personal', 'sandbox', 'sandbox-hosts', 'agent', 'defaults', 'rounds'])(
    'init with projects but none named refuses --%s by name',
    (flag) => {
      const w = setupWorld({ projects: [projectState()] })
      return runInit(w, [`--${flag}`, flag === 'mode' ? 'team' : flag === 'defaults' ? '' : 'x']).then((code) => {
        expect(code).toBe(1)
        expect(w.logged.join('\n')).toContain(flag === 'rounds' ? '--rounds' : `--${flag}`)
        expect(walks).toEqual([])
      })
    },
  )

  it('a move without a terminal refuses by --defaults before removing the mirror', () => {
    const first = setupWorld()
    return runInit(first).then(() => {
      const old = first.recipes.get(PATH)!.replace('remote: /repo', 'remote: /old/repo')
      const w = setupWorld({ text: old, projects: [projectState()], origin: '/old/repo', interactive: false })
      w.branches.set('lingtai-base', 'abc123f')
      return runLocal(w).then((result) => {
        expect(result).toMatchObject({ refused: expect.stringContaining('--defaults') })
        expect(w.events).toEqual([])
        expect(w.writes).toEqual([])
      })
    })
  })

  it('a failed board read or an in-flight attempt refuses before the list', () => {
    const w = setupWorld({
      text: 'version: 2\nrepo:\n  remote: /old/repo\nbranch:\n  main: main\nsource:\n  tickets: db\n  kinds: [bug]\nenv:\n  plantAt: .env.local\n',
      projects: [projectState()],
      origin: '/old/repo',
    })
    w.project.inFlight = () => Effect.fail(new Error('board unreadable'))
    return runLocal(w)
      .then((result) => {
        expect(result).toMatchObject({ refused: expect.stringContaining('board unreadable') })
        expect(walks).toEqual([])
        w.project.inFlight = () => Effect.succeed(['repo#7'])
        return runLocal(w)
      })
      .then((result) => {
        expect(result).toMatchObject({ refused: expect.stringContaining('repo#7') })
        expect(w.writes).toEqual([])
      })
  })

  it.each(['rev-parse', 'symbolic-ref'])("a failed %s keeps git's own words and makes no branch", (command) => {
    const w = setupWorld()
    const git = w.project.git
    w.project.git = (dir, args) =>
      args[0] === command && args[1] !== '--show-toplevel'
        ? Effect.succeed({ ok: false, stdout: '', stderr: 'permission denied reading refs' })
        : git(dir, args)
    return runLocal(w, { local: '/repo', mode: 'solo', defaults: '' }).then((result) => {
      expect(result).toMatchObject({ refused: expect.stringContaining('permission denied reading refs') })
      expect(w.branches.has('lingtai-base')).toBe(false)
      expect(w.writes).toEqual([])
    })
  })

  it("a detached checkout refuses with today's words", () => {
    const w = setupWorld()
    const git = w.project.git
    w.project.git = (dir, args) =>
      args[0] === 'symbolic-ref' ? Effect.succeed({ ok: false, stdout: '', stderr: '' }) : git(dir, args)
    return runLocal(w, { local: '/repo', mode: 'solo', defaults: '' }).then((result) =>
      expect(result).toMatchObject({ refused: expect.stringContaining('/repo has no branch checked out') }),
    )
  })

  it('a case-insensitive duplicate owner is refused before the list', () => {
    const w = setupWorld({ projects: [projectState('Repo', 'acme')] })
    return runLocal(w).then((result) => {
      expect(result).toMatchObject({ refused: expect.stringContaining('acme/repo') })
      expect(walks).toEqual([])
    })
  })

  it('an unchanged registered rerun writes and registers nothing', () => {
    const first = setupWorld()
    return runInit(first).then(() => {
      const w = setupWorld({ text: first.recipes.get(PATH), projects: [projectState()] })
      w.branches.set('lingtai-base', 'abc123f')
      return runLocal(w, { local: '/repo', defaults: '' }).then((result) => {
        expect(result).toMatchObject({ ok: true, unchanged: true })
        expect(w.writes).toEqual([])
        expect(w.registered).toEqual([])
        expect(resolveSource(w.recipes.get(PATH)!, 'repo', 'repo').recipe.source.tickets).toBe('db')
      })
    })
  })

  it.each(['solo', 'team'])('a %s rerun makes its missing working branch even when the recipe is unchanged', (mode) => {
    const flags = { local: '/repo', mode, ...(mode === 'team' ? { personal: 'my-work' } : {}) }
    const base = mode === 'team' ? 'my-work' : 'lingtai-base'
    const first = setupWorld()
    return runLocal(first, { ...flags, defaults: '' }).then(() => {
      const original = first.recipes.get(PATH)!
      const w = setupWorld({ text: original, projects: [{ ...projectState(), base }] })
      const ask = w.project.ask
      w.project.ask = (prompt, opts) => (/Make it from/.test(prompt) ? Promise.resolve('yes') : ask(prompt, opts))
      observe = () => w.events.push('list-finished')
      return runLocal(w, { local: '/repo' }).then((result) => {
        expect(result, w.logged.join('\n')).toMatchObject({ ok: true, base })
        expect(result).not.toHaveProperty('unchanged', true)
        expect(w.branches.get(base)).toBe('abc123f')
        expect(w.events.filter((e) => !e.startsWith('ask:'))).toEqual(['list-finished', `branch:${base}`, 'register'])
        expect(w.recipes.get(PATH)).toBe(original)
        expect(w.writes).toEqual([])
        expect(w.registered[0]).toMatchObject({ base, fromSha: 'abc123f' })
      })
    })
  })

  it('a team personal branch is made only after the whole list, and cancellation makes none', () => {
    const w = setupWorld()
    observe = () => w.events.push('list-finished')
    w.project.ask = (prompt) =>
      Promise.resolve(/Make it from/.test(prompt) ? 'yes' : /use every default/.test(prompt) ? 'no' : '')
    return runLocal(w, { local: '/repo', mode: 'team', personal: 'my-work' }).then((result) => {
      expect(result, w.logged.join('\n')).toMatchObject({ ok: true, base: 'my-work' })
      expect(w.events.filter((e) => !e.startsWith('ask:'))).toEqual([
        'list-finished',
        'branch:my-work',
        'recipe',
        'register',
      ])
      const declined = setupWorld()
      declined.project.ask = (prompt) => Promise.resolve(/Make it from/.test(prompt) ? 'no' : '')
      return runLocal(declined, { local: '/repo', mode: 'team', personal: 'my-work' }).then((result) => {
        expect(result).toMatchObject({ refused: expect.stringContaining('was not made') })
        expect(declined.branches.has('my-work')).toBe(false)
        expect(declined.writes).toEqual([])
      })
    })
  })

  it('team to solo with a pending draft refuses before making the new solo branch', () => {
    const first = setupWorld()
    return runLocal(first, { local: '/repo', mode: 'team', personal: 'my-work', defaults: '' }).then(() => {
      const w = setupWorld({ text: first.recipes.get(PATH), projects: [projectState()] })
      w.branches.set('my-work', 'abc123f')
      return w.store
        .append(prStream('repo', 1), 0, [
          { type: 'PrDraftTicketAdded', actor: 'conductor', data: { ticket: '7', mergeCommit: 'abc123f', from: null } },
        ])
        .then(() => w.store.append('prj-repo', 0, [{ type: 'ProjectPrNumbered', actor: 'conductor', data: { n: 1 } }]))
        .then(() => runLocal(w, { local: '/repo', mode: 'solo', main: 'new-solo', defaults: '' }))
        .then((result) => {
          expect(result).toMatchObject({ refused: expect.stringContaining('mode: team → solo is refused') })
          expect(w.branches.has('new-solo')).toBe(false)
          expect(w.writes).toEqual([])
          expect(w.registered).toEqual([])
        })
    })
  })

  it('team to solo with no pending draft makes its new branch after the recipe check and keeps the personal branch', () => {
    const first = setupWorld()
    return runLocal(first, { local: '/repo', mode: 'team', personal: 'my-work', defaults: '' }).then(() => {
      const w = setupWorld({ text: first.recipes.get(PATH), projects: [projectState()] })
      w.branches.set('my-work', 'abc123f')
      return runLocal(w, { local: '/repo', mode: 'solo', main: 'new-solo', defaults: '' }).then((result) => {
        expect(result, w.logged.join('\n')).toMatchObject({ ok: true, base: 'new-solo' })
        expect(w.events.filter((e) => !e.startsWith('ask:'))).toEqual(['recipe', 'branch:new-solo', 'register'])
        expect(w.branches.get('my-work')).toBe('abc123f')
      })
    })
  })

  it('a changed solo base is cut from the old working branch after the list', () => {
    const first = setupWorld()
    return runInit(first).then(() => {
      const w = setupWorld({ text: first.recipes.get(PATH), projects: [projectState()] })
      w.branches.set('lingtai-base', 'bbb222')
      return runLocal(w, { local: '/repo', mode: 'solo', main: 'new-base', defaults: '' }).then((result) => {
        expect(result).toMatchObject({ ok: true, base: 'new-base' })
        expect(w.branches.get('new-base')).toBe('bbb222')
        expect(w.registered[0]?.fromSha).toBe('bbb222')
      })
    })
  })

  it('an unreadable recipe and an unrelated same-name checkout refuse before the list', () => {
    const w = setupWorld({ text: 'version: 2\nbranch: [bad]\nrepo:\n  remote: /repo\n', projects: [projectState()] })
    return runLocal(w).then((result) => {
      expect(result).toMatchObject({ refused: expect.stringContaining('does not resolve') })
      const other = setupWorld({
        text: 'version: 2\nrepo:\n  remote: /other/repo\n',
        projects: [projectState()],
      })
      return runLocal(other).then((result) =>
        expect(result).toMatchObject({ refused: expect.stringContaining('silently redirect') }),
      )
    })
  })
  it('solo to team keeps the working branch and detects the trunk from the checkout', () => {
    const first = setupWorld()
    first.branches.set('my-work', 'bbb222')
    return runLocal(first, { local: '/repo', mode: 'solo', main: 'my-work', defaults: '' }).then(() => {
      const w = setupWorld({ text: first.recipes.get(PATH), projects: [projectState()] })
      w.branches.set('my-work', 'bbb222')
      return runLocal(w, { local: '/repo', mode: 'team', defaults: '' }).then((result) => {
        expect(result).toMatchObject({ ok: true, base: 'my-work' })
        expect(resolveSource(w.recipes.get(PATH)!, 'repo', 'repo').recipe.branch).toMatchObject({
          main: 'main',
          personal: 'my-work',
        })
        expect(w.events.filter((e) => e.startsWith('branch:'))).toEqual([])
        expect(w.branches.get('my-work')).toBe('bbb222')
      })
    })
  })
})
