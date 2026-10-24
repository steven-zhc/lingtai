import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRuntime } from '@lingtai/agent'
import { git, mirrorPathFor } from '@lingtai/repo'
import { afterEach, expect, it } from 'vitest'

import { prepareTriageCheckout } from '../src/triage-checkout.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('lets Codex CLI tools inspect the selected commit while its edits stay in a private checkout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'triage-fixture-'))
  roots.push(root)
  const source = join(root, 'source')
  const mirror = mirrorPathFor('project', root)
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }
  await mkdir(join(root, 'repos'))
  await git(['init', source], { env })
  await git(['config', 'user.name', 'Fixture'], { cwd: source, env })
  await git(['config', 'user.email', 'fixture@example.invalid'], { cwd: source, env })
  await writeFile(join(source, 'answer.txt'), 'base\n')
  await git(['add', 'answer.txt'], { cwd: source, env })
  await git(['commit', '-m', 'base'], { cwd: source, env })
  const base = await git(['rev-parse', 'HEAD'], { cwd: source, env })
  await writeFile(join(source, 'answer.txt'), 'attempt head\n')
  await git(['commit', '-am', 'head'], { cwd: source, env })
  const head = await git(['rev-parse', 'HEAD'], { cwd: source, env })
  await git(['clone', '--bare', source, mirror], { env })

  const standIn = join(root, 'codex-stand-in.cjs')
  await writeFile(
    standIn,
    `#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
const cwd = args[args.indexOf('--cd') + 1];
const text = execFileSync('sh', ['-c', 'cat answer.txt'], { cwd, encoding: 'utf8' }).trim();
execFileSync('sh', ['-c', "printf 'edited by tool\\n' > answer.txt"], { cwd });
console.log(JSON.stringify({type:'thread.started',thread_id:'fixture'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:2,output_tokens:2}}));
`,
  )
  await chmod(standIn, 0o700)
  const runtime = createRuntime('codex', { tools: 'full', binary: standIn })

  for (const [sha, expected] of [
    [head, 'attempt head'],
    [base, 'base'],
  ]) {
    const checkout = await prepareTriageCheckout('project', sha!, root)
    try {
      expect(await git(['rev-parse', 'HEAD'], { cwd: checkout.cwd, env: checkout.env })).toBe(sha)
      expect(await git(['remote'], { cwd: checkout.cwd, env: checkout.env })).toBe('')
      const result = await runtime.run({
        runId: `triage-${sha}`,
        cwd: checkout.cwd,
        prompt: 'Inspect answer.txt',
        settingsPath: checkout.settingsPath,
        env: checkout.env,
        limits: { turns: 3, wallMs: 10_000, usd: 0.5 },
      })
      expect(result.failure).toBeNull()
      expect(result.text).toBe(expected)
      expect(await readFile(join(checkout.cwd, 'answer.txt'), 'utf8')).toBe('edited by tool\n')
    } finally {
      await checkout.cleanup()
    }
    expect(await readFile(join(source, 'answer.txt'), 'utf8')).toBe('attempt head\n')
    expect(await git(['rev-parse', 'HEAD'], { cwd: mirror, env })).toBe(head)
  }
})

it('hands a login Codex refreshed in the private home back to the original', async () => {
  const root = await mkdtemp(join(tmpdir(), 'triage-auth-'))
  roots.push(root)
  const source = join(root, 'source')
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }
  await mkdir(join(root, 'repos'))
  await git(['init', source], { env })
  await git(['config', 'user.name', 'Fixture'], { cwd: source, env })
  await git(['config', 'user.email', 'fixture@example.invalid'], { cwd: source, env })
  await writeFile(join(source, 'a.txt'), 'a\n')
  await git(['add', 'a.txt'], { cwd: source, env })
  await git(['commit', '-m', 'base'], { cwd: source, env })
  const sha = await git(['rev-parse', 'HEAD'], { cwd: source, env })
  await git(['clone', '--bare', source, mirrorPathFor('project', root)], { env })
  const home = join(root, 'home')
  await mkdir(join(home, '.codex'), { recursive: true })
  const auth = join(home, '.codex', 'auth.json')
  await writeFile(auth, '{"refresh":"old"}')
  const saved = process.env['HOME']
  process.env['HOME'] = home
  try {
    const checkout = await prepareTriageCheckout('project', sha, root)
    expect(await readFile(join(checkout.env['CODEX_HOME']!, 'auth.json'), 'utf8')).toBe('{"refresh":"old"}')
    await writeFile(join(checkout.env['CODEX_HOME']!, 'auth.json'), '{"refresh":"new"}')
    await checkout.cleanup()
    expect(await readFile(auth, 'utf8')).toBe('{"refresh":"new"}')

    const second = await prepareTriageCheckout('project', sha, root)
    await writeFile(join(second.env['CODEX_HOME']!, 'auth.json'), '{"refresh":"stale"}')
    await writeFile(auth, '{"refresh":"newer"}')
    await second.cleanup()
    expect(await readFile(auth, 'utf8')).toBe('{"refresh":"newer"}')
  } finally {
    if (saved === undefined) delete process.env['HOME']
    else process.env['HOME'] = saved
  }
})
