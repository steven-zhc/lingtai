import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

/**
 * `kept-run-port.ts`'s staging, against a real git binary (`#470`). A fake
 * `GitHere` answers whatever a test script says, so `unit/kept-run-port.test.ts`
 * cannot see git's own exit code — and that exit code is the whole finding:
 * `git add -A -- . ':(exclude)<path>'` exits 1 whenever `<path>` is itself
 * covered by the repository's own `.gitignore`, even though it staged
 * everything else. This repository's own `.gitignore` covers the planted env
 * file (`.env.*`), which is exactly the case that could never be kept before
 * this fix.
 */
import { WIP_COMMIT_PREFIX } from '@lingtai/domain'
import { Either } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import { commitWipExceptPlanted, type GitHere, keptRunPort } from '../src/kept-run-port.ts'

const exec = promisify(execFile)
const PLANT = '.env.local'
const MESSAGE = `${WIP_COMMIT_PREFIX}test stopped by out-of-turns`

function gitHere(cwd: string): GitHere {
  return async (args) => {
    try {
      const { stdout } = await exec('git', args, { cwd })
      return Either.right(stdout.trim())
    } catch (error) {
      return Either.left({ detail: (error as Error).message })
    }
  }
}

/**
 * An isolated repository, with an identity of its own so the machine's
 * global git config — hooks, signing — cannot decide the result. Neither
 * `commitWipExceptPlanted` (passed its own `-c user.name=…` on the command
 * line) nor `keptRunPort.keep`'s plain `commit -m` (which sets no identity)
 * can commit without one.
 */
async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lingtai-kept-run-port-'))
  await exec('git', ['init', '-q', '-b', 'main', dir])
  await exec('git', ['-C', dir, 'config', 'user.name', 'Test'])
  await exec('git', ['-C', dir, 'config', 'user.email', 't@example.invalid'])
  await exec('git', ['-C', dir, 'config', 'commit.gpgsign', 'false'])
  await writeFile(join(dir, 'README.md'), 'first\n')
  await exec('git', ['-C', dir, 'add', 'README.md'])
  await exec('git', ['-C', dir, 'commit', '-q', '-m', 'first'])
  return dir
}

async function subjectOf(dir: string): Promise<string> {
  const { stdout } = await exec('git', ['-C', dir, 'log', '-1', '--format=%s'])
  return stdout.trim()
}

async function filesInHead(dir: string): Promise<string[]> {
  const { stdout } = await exec('git', ['-C', dir, 'show', '--name-only', '--format=', 'HEAD'])
  return stdout
    .trim()
    .split('\n')
    .filter((line) => line !== '')
}

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('commitWipExceptPlanted, against a real git repository', () => {
  it('commits everything but the planted file when the repository ignores it (#467)', async () => {
    const dir = await makeRepo()
    dirs.push(dir)
    await writeFile(join(dir, '.gitignore'), '.env.*\n')
    await exec('git', ['-C', dir, 'add', '.gitignore'])
    await exec('git', ['-C', dir, 'commit', '-q', '-m', 'ignore the env file'])
    await writeFile(join(dir, 'a.txt'), 'x\n')
    await writeFile(join(dir, PLANT), 's\n')

    const result = await commitWipExceptPlanted(gitHere(dir), PLANT, MESSAGE)
    expect(result).toEqual({ ok: true })
    expect(await filesInHead(dir)).toEqual(['a.txt'])
    expect(await subjectOf(dir)).toBe(MESSAGE)
  })

  it('leaves the planted file out even when the agent staged it itself, with no ignore rule', async () => {
    const dir = await makeRepo()
    dirs.push(dir)
    await writeFile(join(dir, 'a.txt'), 'x\n')
    await writeFile(join(dir, PLANT), 's\n')
    await exec('git', ['-C', dir, 'add', PLANT, 'a.txt'])

    const result = await commitWipExceptPlanted(gitHere(dir), PLANT, MESSAGE)
    expect(result).toEqual({ ok: true })
    expect(await filesInHead(dir)).toEqual(['a.txt'])
  })
})

describe('keptRunPort.keep, against a real git repository', () => {
  it('commits the non-planted change alone when the repository ignores the planted file', async () => {
    const dir = await makeRepo()
    dirs.push(dir)
    await writeFile(join(dir, '.gitignore'), '.env.*\n')
    await exec('git', ['-C', dir, 'add', '.gitignore'])
    await exec('git', ['-C', dir, 'commit', '-q', '-m', 'ignore the env file'])
    await writeFile(join(dir, 'a.txt'), 'x\n')
    await writeFile(join(dir, PLANT), 's\n')

    const port = keptRunPort({
      git: gitHere(dir),
      plantAt: PLANT,
      issue: '470',
      recordCompletion: async () => {},
    })
    const result = await port.keep('format')
    expect('committed' in result).toBe(true)
    expect(await filesInHead(dir)).toEqual(['a.txt'])

    await writeFile(join(dir, PLANT), 'changed again\n')
    const second = await port.keep('format')
    expect(second).toEqual({ nothing: true })
  })
})
