/**
 * The command runner, against real processes.
 *
 * Nothing is mocked, for `action.test.ts`'s reason: a command is a process and an
 * exit code, and a test that stubs the process is testing nothing. Here the
 * properties under test are 0037 §4's two new channels — JSON in on stdin, a
 * richer answer out through `LINGTAI_RESULT` — and, ahead of both of them, the
 * constraint that shapes them: **a command that ignores stdin and writes no
 * file behaves exactly as it does today.** Most of what follows is pinning
 * that, because it is what would break silently.
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Effect } from 'effect'
import { beforeEach, describe, expect, it } from 'vitest'

import { commandEffect } from '../src/index.ts'

const env = { PATH: process.env['PATH'] ?? '' }
let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'lingtai-command-'))
})

const run = (options: Partial<Parameters<typeof commandEffect>[0]> & { run: string }) =>
  Effect.runPromise(commandEffect({ timeoutMs: 10_000, cwd, env, ...options }))

const elapsedAside = (evidence: string) => evidence.replace(/\d+\.\d+s/, '<elapsed>')

describe('a payload on stdin', () => {
  it('reaches the command as JSON, and the stream is closed', async () => {
    const outcome = await run({
      run: 'cat > payload.json',
      payload: { runId: 'pass-01JX', ticket: { number: 122 } },
    })

    // `cat` returning at all is half the assertion: a stdin that stayed open
    // would hang here until the timeout.
    expect(outcome.ok).toBe(true)
    expect(JSON.parse(await readFile(join(cwd, 'payload.json'), 'utf8'))).toEqual({
      runId: 'pass-01JX',
      ticket: { number: 122 },
    })
  })

  /**
   * The reason it is stdin and not the environment. A real `RunPrompted` in
   * this log carried `bytes: 4555`, and this is an order of magnitude past both
   * that and the pipe's own buffer.
   */
  it('carries a payload far larger than an environment would hold', async () => {
    const payload = { prompt: 'x'.repeat(100_000) }
    const outcome = await run({ run: 'cat > payload.json', payload })

    expect(outcome.ok).toBe(true)
    expect(JSON.parse(await readFile(join(cwd, 'payload.json'), 'utf8'))).toEqual(payload)
  })

  /**
   * The constraint the whole ticket is shaped by: every `run:` in every recipe
   * today ignores stdin, and must go on producing exactly what it does now. A
   * command that exits without draining the pipe leaves us writing to a closed
   * one, and that EPIPE is not a failure of the command.
   */
  it('does not change the outcome of a command that never reads it', async () => {
    const script = "echo 'src/a.ts(12,3): error TS2345'; echo boom >&2; exit 2"
    const ignoring = await run({ run: script })
    const fed = await run({ run: script, payload: { prompt: 'y'.repeat(100_000) } })

    expect(fed.ok).toBe(ignoring.ok)
    expect(fed.exitCode).toBe(ignoring.exitCode)
    expect(fed.timedOut).toBe(ignoring.timedOut)
    // Every word of the evidence but how long it took, which is the one part
    // two runs of the same script are not obliged to agree on.
    expect(elapsedAside(fed.evidence)).toBe(elapsedAside(ignoring.evidence))
    expect(fed.evidence).toContain('error TS2345')
    expect(fed.evidence).toContain('boom')
  })

  it('leaves stdin at /dev/null when there is no payload, so a reader gets EOF', async () => {
    // Not a hang and not an error: the same empty read `run:` gets today.
    const outcome = await run({ run: 'cat > read.txt' })

    expect(outcome.ok).toBe(true)
    expect(await readFile(join(cwd, 'read.txt'), 'utf8')).toBe('')
  })
})

describe('LINGTAI_RESULT', () => {
  it('names a path the command can write, and valid JSON there is read', async () => {
    const resultPath = join(cwd, 'result.json')
    const outcome = await run({
      run: `printf '{"verdict":"request-approval","who":"release"}' > "$LINGTAI_RESULT"`,
      resultPath,
    })

    expect(outcome.ok).toBe(true)
    expect(outcome.result).toEqual({ verdict: 'request-approval', who: 'release' })
  })

  it('is absent from the environment when the caller named no path', async () => {
    // A command must not inherit a meaning from a run it was not part of.
    const outcome = await run({ run: 'echo "[${LINGTAI_RESULT-unset}]"; exit 1' })

    expect(outcome.evidence).toContain('[unset]')
  })

  it('says nothing when the command writes nothing, which is every `run:` today', async () => {
    const outcome = await run({ run: 'echo built', resultPath: join(cwd, 'result.json') })

    expect(outcome.ok).toBe(true)
    expect(outcome.result).toBeUndefined()
    expect(outcome.evidence).toContain('exited 0')
    expect(outcome.evidence).not.toContain('LINGTAI_RESULT')
  })

  /**
   * Garbage is a bug in an extension, and the two halves of the answer are
   * separable: the exit code still decides, and the parse failure is evidence
   * rather than silence. A broken writer must not turn a passing command into a
   * failing one.
   */
  it('falls back to the exit code on garbage, with the parse failure as evidence', async () => {
    const resultPath = join(cwd, 'result.json')
    const outcome = await run({ run: `echo 'not json' > "$LINGTAI_RESULT"`, resultPath })

    expect(outcome.ok).toBe(true)
    expect(outcome.exitCode).toBe(0)
    expect(outcome.result).toBeUndefined()
    expect(outcome.evidence).toContain('LINGTAI_RESULT')
    expect(outcome.evidence).toContain('is not JSON')
  })

  it('does not let a result file rescue a non-zero exit', async () => {
    const resultPath = join(cwd, 'result.json')
    await writeFile(resultPath, '{"verdict":"passed"}')
    const outcome = await run({ run: 'echo nope >&2; exit 1', resultPath })

    expect(outcome.ok).toBe(false)
    expect(outcome.exitCode).toBe(1)
    expect(outcome.result).toEqual({ verdict: 'passed' })
    // stdout is still evidence, unchanged.
    expect(outcome.evidence).toContain('nope')
  })
})

/**
 * The timeout is a bound on every `run:`, #390's review found it could stop
 * being one: reporting on `close` waits for every holder of the stdio pipes,
 * and a background process the command left behind holds them for good.
 */
describe('a command that times out', () => {
  it('is reported once the command itself exits, though a background process still holds its output', async () => {
    const started = Date.now()
    const outcome = await run({ run: 'sleep 30 & sleep 30', timeoutMs: 300, timeoutLabel: '300ms' })

    expect(outcome.ok).toBe(false)
    expect(outcome.timedOut).toBe(true)
    expect(outcome.evidence).toContain('timed out after 300ms')
    // SIGTERM ends the shell at once; the backgrounded sleep keeps the pipes open.
    expect(Date.now() - started).toBeLessThan(7_000)
  }, 15_000)
})

describe('an aborted command with ownGroup', () => {
  it('is reported only after what its shell started is gone too', async () => {
    const controller = new AbortController()
    const pidFile = join(cwd, 'pid')
    const pending = run({
      // The inner shell ignores SIGTERM and outlives the outer one.
      run: `sh -c 'trap "" TERM; sleep 30' & echo $! > ${pidFile}; wait`,
      ownGroup: true,
      signal: controller.signal,
    })
    await new Promise((r) => setTimeout(r, 500))
    controller.abort()
    const outcome = await pending
    expect(outcome.evidence).toContain('aborted')
    const pid = Number((await readFile(pidFile, 'utf8')).trim())
    expect(() => process.kill(pid, 0)).toThrow()
  }, 15_000)
})

describe('a timed-out command with ownGroup', () => {
  it('is reported only after what its shell started is gone too', async () => {
    const pidFile = join(cwd, 'pid-timeout')
    const outcome = await run({
      run: `sh -c 'trap "" TERM; sleep 30' & echo $! > ${pidFile}; wait`,
      ownGroup: true,
      timeoutMs: 500,
    })
    expect(outcome.timedOut).toBe(true)
    const pid = Number((await readFile(pidFile, 'utf8')).trim())
    expect(() => process.kill(pid, 0)).toThrow()
  }, 15_000)
})
