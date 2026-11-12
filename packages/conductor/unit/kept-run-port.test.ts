/**
 * `keptRunPort` (#390), against a git that records what it was asked and
 * answers from a script. No git binary, so this is `unit/` by 0060 §1, and it
 * is what pins the two traps `doc/design/390.md` names: `clean` resets to the
 * agent's own `HEAD`, never the base, and the planted env file is spared by
 * both the clean and the add. It cannot see `#470`'s own trap — a fake git
 * answers whatever the test says, never git's real exit code on a `:(exclude)`
 * pathspec whose path is itself gitignored — so this only pins call order; the
 * exit-code trap is `integration/kept-run-port.test.ts`'s.
 */
import { makeAgentAction, type AgentPortDeps } from '@lingtai/actions'
import { Deferred, Effect, Exit, Fiber, Result } from 'effect'
import { describe, expect, it } from 'vitest'

import { type GitHere, keptRunPort, onlyThePlantedFileIsDirty, restoreAfterReview } from '../src/kept-run-port.ts'

const PLANT = 'apps/web/.env.local'

function fakeGit(answers: Record<string, Result.Result<string, { detail: string }>> = {}) {
  const asked: string[][] = []
  const git: GitHere = (args) =>
    Effect.sync(() => {
      asked.push(args)
      return answers[args.join(' ')] ?? Result.succeed('')
    })
  return { git, asked }
}

describe('keptRunPort.clean', () => {
  it('resets to HEAD and cleans with the planted file spared, in that order', async () => {
    const { git, asked } = fakeGit()
    const port = keptRunPort({ git, plantAt: PLANT, issue: '390', recordCompletion: () => Effect.void })
    expect(await Effect.runPromise(port.clean())).toEqual({ ok: true })
    expect(asked).toEqual([
      ['reset', '--hard', 'HEAD'],
      ['clean', '-fd', '-e', `/${PLANT}`],
    ])
  })

  it('stops at a refused reset, and says which call refused', async () => {
    const { git, asked } = fakeGit({ 'reset --hard HEAD': Result.fail({ detail: 'index.lock exists' }) })
    const port = keptRunPort({ git, plantAt: PLANT, issue: '390', recordCompletion: () => Effect.void })
    expect(await Effect.runPromise(port.clean())).toEqual({ failed: 'git reset refused it: index.lock exists' })
    expect(asked).toHaveLength(1)
  })
})

describe('keptRunPort.keep', () => {
  it('adds everything, unstages the planted file, commits, and records the new head', async () => {
    const recorded: string[] = []
    const { git, asked } = fakeGit({
      // `--quiet` implies `--exit-code`: a left is *something is staged*.
      'diff --cached --quiet': Result.fail({ detail: 'exit 1' }),
      'rev-parse HEAD': Result.succeed('abc1234'),
    })
    const port = keptRunPort({
      git,
      plantAt: PLANT,
      issue: '390',
      recordCompletion: (head) =>
        Effect.sync(() => {
          recorded.push(head)
        }),
    })
    expect(await Effect.runPromise(port.keep('format'))).toEqual({ committed: 'abc1234' })
    expect(asked).toEqual([
      ['add', '-A'],
      ['reset', '-q', '--', PLANT],
      ['diff', '--cached', '--quiet'],
      ['commit', '-m', 'chore(implement): format for #390'],
      ['rev-parse', 'HEAD'],
    ])
    expect(recorded).toEqual(['abc1234'])
  })

  it('commits and records nothing when the command changed nothing', async () => {
    const recorded: string[] = []
    const { git, asked } = fakeGit()
    const port = keptRunPort({
      git,
      plantAt: PLANT,
      issue: '390',
      recordCompletion: (head) =>
        Effect.sync(() => {
          recorded.push(head)
        }),
    })
    expect(await Effect.runPromise(port.keep('format'))).toEqual({ nothing: true })
    expect(asked.map((a) => a[0])).toEqual(['add', 'reset', 'diff'])
    expect(recorded).toEqual([])
  })

  it('stops at a refused add, and never reaches the commit', async () => {
    const recorded: string[] = []
    const { git, asked } = fakeGit({ 'add -A': Result.fail({ detail: 'index.lock exists' }) })
    const port = keptRunPort({
      git,
      plantAt: PLANT,
      issue: '390',
      recordCompletion: (head) =>
        Effect.sync(() => {
          recorded.push(head)
        }),
    })
    expect(await Effect.runPromise(port.keep('format'))).toEqual({ failed: 'git add refused it: index.lock exists' })
    expect(asked).toEqual([['add', '-A']])
    expect(recorded).toEqual([])
  })
})

describe('onlyThePlantedFileIsDirty', () => {
  it('reads a porcelain line for the planted file alone as a clean tree', () => {
    expect(onlyThePlantedFileIsDirty('', PLANT)).toBe(true)
    expect(onlyThePlantedFileIsDirty(`?? ${PLANT}\n`, PLANT)).toBe(true)
  })

  it('is dirty when any other path is, with or without the planted line', () => {
    expect(onlyThePlantedFileIsDirty(' M src/a.ts\n', PLANT)).toBe(false)
    expect(onlyThePlantedFileIsDirty(`?? ${PLANT}\n?? notes.md\n`, PLANT)).toBe(false)
  })

  it('reads a quoted porcelain line as dirty, and a NUL-separated one by its real path', () => {
    expect(onlyThePlantedFileIsDirty('?? "private env"\n', 'private env')).toBe(false)
    expect(onlyThePlantedFileIsDirty('?? private env\0', 'private env')).toBe(true)
    expect(onlyThePlantedFileIsDirty('?? private env\0?? other\0', 'private env')).toBe(false)
  })

  it('is dirty when the planted file is staged or modified, not merely untracked', () => {
    expect(onlyThePlantedFileIsDirty(`A  ${PLANT}\n`, PLANT)).toBe(false)
    expect(onlyThePlantedFileIsDirty(` M ${PLANT}\n`, PLANT)).toBe(false)
  })
})

describe('restoreAfterReview (#587)', () => {
  const ON = 'a'.repeat(40)

  it('reads only, and answers untouched, when HEAD is onSha and only the planted file is untracked', async () => {
    const { git, asked } = fakeGit({
      'rev-parse HEAD': Result.succeed(ON),
      'status --porcelain -z --untracked-files=all': Result.succeed(`?? ${PLANT}`),
    })
    expect(await Effect.runPromise(restoreAfterReview({ git, plantAt: PLANT })(ON))).toEqual({ untouched: true })
    expect(asked).toEqual([
      ['rev-parse', 'HEAD'],
      ['status', '--porcelain', '-z', '--untracked-files=all'],
      ['symbolic-ref', '-q', 'HEAD'],
    ])
  })

  it('reads an unnormalized plantAt as the file porcelain reports, and spares that path', async () => {
    const { git, asked } = fakeGit({
      'rev-parse HEAD': Result.succeed(ON),
      'status --porcelain -z --untracked-files=all': Result.succeed('?? .env.local'),
    })
    expect(await Effect.runPromise(restoreAfterReview({ git, plantAt: './.env.local' })(ON))).toEqual({
      untouched: true,
    })
    expect(asked.some((args) => args[0] === 'clean')).toBe(false)

    const dirty = fakeGit({
      'rev-parse HEAD': Result.succeed('b'.repeat(40)),
      'status --porcelain -z --untracked-files=all': Result.succeed('?? .env.local'),
    })
    await Effect.runPromise(restoreAfterReview({ git: dirty.git, plantAt: './.env.local' })(ON))
    expect(dirty.asked).toContainEqual(['clean', '-ffd', '-e', '/.env.local'])
  })

  it('resets to onSha and cleans with the planted file spared, and says what it found', async () => {
    const statuses = [` M src/a.ts\n?? ${PLANT}\n?? scratch.md`, `?? ${PLANT}`]
    const asked: string[][] = []
    const git: GitHere = (args) =>
      Effect.sync(() => {
        asked.push(args)
        if (args[0] === 'rev-parse') return Result.succeed('b'.repeat(40))
        if (args[0] === 'status') return Result.succeed(statuses.shift() ?? '')
        return Result.succeed('')
      })
    const answer = await Effect.runPromise(restoreAfterReview({ git, plantAt: PLANT })(ON))

    expect(asked.slice(3, 6)).toEqual([
      ['reset', '--mixed', ON],
      ['checkout', '--', '.'],
      ['clean', '-ffd', '-e', `/${PLANT}`],
    ])
    expect(answer).toMatchObject({ restored: expect.stringContaining('src/a.ts, scratch.md') })
    expect(answer).toMatchObject({ restored: expect.stringContaining('HEAD was bbbbbbb') })
    expect(answer).toMatchObject({ restored: expect.not.stringContaining(PLANT) })
  })

  it('escapes pattern characters in plantAt, so the clean spares that literal file', async () => {
    const plant = '.env[local]*?'
    const { git, asked } = fakeGit({
      'rev-parse HEAD': Result.succeed('b'.repeat(40)),
      'status --porcelain -z --untracked-files=all': Result.succeed(`?? ${plant}`),
    })
    await Effect.runPromise(restoreAfterReview({ git, plantAt: plant })(ON))
    expect(asked).toContainEqual(['clean', '-ffd', '-e', '/.env\\[local\\]\\*\\?'])
  })

  it('detaches from a branch the reviewer checked out before it resets, so the branch is not moved', async () => {
    const { git, asked } = fakeGit({
      'rev-parse HEAD': Result.succeed(ON),
      'symbolic-ref -q HEAD': Result.succeed('refs/heads/other\n'),
      'status --porcelain -z --untracked-files=all': Result.succeed(`?? ${PLANT}`),
    })
    const answer = await Effect.runPromise(restoreAfterReview({ git, plantAt: PLANT })(ON))

    expect(asked.slice(3, 5)).toEqual([
      ['update-ref', '--no-deref', 'HEAD', ON],
      ['reset', '--mixed', ON],
    ])
    expect(answer).toMatchObject({ restored: expect.stringContaining('on refs/heads/other') })
  })

  it('fails when the tree is still dirty after the clean, whatever the exit codes said', async () => {
    const answers = [Result.succeed('b'.repeat(40)), Result.succeed('?? nested/')]
    const git: GitHere = (args) =>
      Effect.sync(() => {
        if (args[0] === 'rev-parse') return answers[0]!
        if (args[0] === 'status') return answers[1]!
        return Result.succeed('')
      })
    expect(await Effect.runPromise(restoreAfterReview({ git, plantAt: PLANT })(ON))).toMatchObject({
      failed: expect.stringContaining('still dirty'),
    })
  })

  it('fails by name when the reset is refused', async () => {
    const { git } = fakeGit({
      'rev-parse HEAD': Result.succeed('b'.repeat(40)),
      [`reset --mixed ${ON}`]: Result.fail({ detail: 'index.lock exists' }),
    })
    expect(await Effect.runPromise(restoreAfterReview({ git, plantAt: PLANT })(ON))).toEqual({
      failed: 'git reset refused it: index.lock exists',
    })
  })
})

describe('the restore under interruption (#1043, #587)', () => {
  it('runs whole when the review is interrupted during its dispatch', async () => {
    const ON = 'a'.repeat(40)
    const log: string[] = []
    const entered = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    const git: GitHere = (args) =>
      Effect.gen(function* () {
        log.push(args.join(' '))
        if (args[0] === 'rev-parse') return Result.succeed('b'.repeat(40))
        if (args[0] === 'status') return Result.succeed(log.includes('checkout -- .') ? '' : ' M src/a.ts')
        if (args[0] === 'symbolic-ref') return Result.fail({ detail: 'detached' })
        if (args[0] === 'reset') {
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(release)
        }
        return Result.succeed('')
      })

    let dispatched: () => void = () => {}
    const dispatchedP = new Promise<void>((resolve) => {
      dispatched = resolve
    })
    const deps: AgentPortDeps = {
      runtime: {
        capabilities: {
          id: 'claude-code',
          hooks: [],
          canFailClosed: true,
          canRewriteToolCall: false,
          providesTier: 'guarded',
          enforces: ['turns', 'wall'],
        },
        run: (request) =>
          new Promise((_, reject) => {
            dispatched()
            request.signal?.addEventListener('abort', () => reject(new Error('aborted')))
          }),
      },
      issue: () => Effect.succeed({ ref: '1', title: 't', body: '' }),
      diff: () => Effect.succeed('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-a\n+b\n'),
      restore: restoreAfterReview({ git, plantAt: PLANT }),
      settingsPath: '/tmp/settings.json',
      limits: { turns: 40, wallMs: 60_000, diffBytes: 400_000 },
    }
    const port = makeAgentAction({ name: 'review', prompt: '' }, deps)

    const fiber = Effect.runFork(port.run({ runId: 'pass-abc', onSha: ON, cwd: '/tmp/wt', env: {} }))
    await dispatchedP
    const interrupt = Effect.runFork(Fiber.interrupt(fiber))
    await Effect.runPromise(Deferred.await(entered))
    // The restore is parked on `reset`: the interruption has not finished.
    expect(interrupt.pollUnsafe()).toBeUndefined()
    await Effect.runPromise(Deferred.succeed(release, undefined))
    await Effect.runPromise(Fiber.join(interrupt))
    const exit = await Effect.runPromise(Fiber.await(fiber))

    expect(Exit.hasInterrupts(exit)).toBe(true)
    expect(log).toContain(`reset --mixed ${ON}`)
    expect(log.indexOf(`reset --mixed ${ON}`)).toBeLessThan(log.indexOf('checkout -- .'))
  })
})
