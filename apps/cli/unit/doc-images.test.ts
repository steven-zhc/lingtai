/**
 * The sync of `doc/` images with R2 (#1469): the plan, the credential check and
 * the run, against an in-memory store and filesystem. Nothing here reaches the
 * network, the disk or `$HOME`; the "secrets" are obvious placeholders.
 */
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  CREDENTIAL_NAMES,
  plan,
  run,
  validKey,
  type DocFs,
  type ObjectStore,
  type RemoteObject,
  type StoreConfig,
  type StoreFactory,
} from '../src/doc-images.ts'

const md5 = (s: string): string => (s === 'a' ? '0cc175b9c0f1b6a831c399e269772661' : 'ffffffffffffffffffffffffffffffff')

describe('plan', () => {
  const local = [
    { key: 'img/new.png', md5: md5('a') },
    { key: 'img/same.png', md5: md5('a') },
    { key: 'img/changed.png', md5: md5('a') },
    { key: 'img/multi.png', md5: md5('a') },
  ]
  const remote: RemoteObject[] = [
    { key: 'img/same.png', etag: `"${md5('a')}"` },
    { key: 'img/changed.png', etag: `"${md5('b')}"` },
    { key: 'img/multi.png', etag: `"${md5('a')}-3"` },
    { key: 'only/remote.webp', etag: '"x"' },
    { key: '../x.png' },
    { key: '/abs.png' },
    { key: 'IMG.PNG' },
    { key: 'notes.txt' },
  ]
  const p = plan(local, remote)

  it('uploads what is absent, skips what is equal, replaces what differs', () => {
    expect(p.upload).toEqual(['img/new.png'])
    expect(p.skip).toEqual(['img/same.png'])
    expect(p.replace).toEqual(['img/changed.png', 'img/multi.png'])
  })

  it('downloads only valid remote keys with no local file, and names the refused', () => {
    expect(p.download).toEqual(['only/remote.webp'])
    expect(p.remoteOnlyRefused).toEqual(['../x.png', '/abs.png', 'IMG.PNG', 'notes.txt'])
  })

  it('never plans a deletion', () => {
    expect(Object.keys(p).sort()).toEqual(['download', 'remoteOnlyRefused', 'replace', 'skip', 'upload'])
  })

  it('accepts only keys the walk would produce', () => {
    expect(validKey('img/016/a.jpeg')).toBe(true)
    for (const bad of ['a/../b.png', 'a//b.png', './a.png', 'a.PNG', 'a.svg', 'a\\b.png'])
      expect(validKey(bad)).toBe(false)
  })
})

const SECRETS: Record<string, string> = {
  LINGTAI_R2_ACCOUNT_ID: 'acct-placeholder-1',
  LINGTAI_R2_ACCESS_KEY_ID: 'akid-placeholder-2',
  LINGTAI_R2_SECRET_ACCESS_KEY: 'secret-placeholder-3',
}

const emptyFs = (files: Record<string, string> = {}): DocFs & { written: string[] } => {
  const written: string[] = []
  return {
    written,
    walk: () => Promise.resolve([...Object.keys(files), 'readme.md']),
    read: (k) => Promise.resolve(new TextEncoder().encode(files[k] ?? '')),
    write: (k) => {
      if (k in files) return Promise.resolve('exists' as const)
      written.push(k)
      return Promise.resolve('written' as const)
    },
  }
}

const fakeStore = (pages: RemoteObject[][], puts: string[] = []): ObjectStore => ({
  list: (token) => {
    const i = token === undefined ? 0 : Number(token)
    return Promise.resolve({ objects: pages[i] ?? [], next: i + 1 < pages.length ? String(i + 1) : undefined })
  },
  put: (k, _b, ct) => {
    puts.push(`${k} ${ct}`)
    return Promise.resolve()
  },
  get: () => Promise.resolve(new Uint8Array([1])),
})

describe('credentials', () => {
  for (const name of CREDENTIAL_NAMES) {
    it(`fails before any store exists when ${name} is unset, naming no other value`, async () => {
      const env = { ...SECRETS, [name]: undefined }
      const built: StoreConfig[] = []
      const factory: StoreFactory = (c) => {
        built.push(c)
        return fakeStore([])
      }
      const out = await Effect.runPromise(Effect.flip(run('list', { env, store: factory, fs: emptyFs() })))
      expect(built).toEqual([])
      expect(out.message).toContain(name)
      for (const [other, value] of Object.entries(SECRETS)) {
        if (other !== name) expect(out.message).not.toContain(value)
      }
    })
  }

  it('lists every missing name at once', async () => {
    const out = await Effect.runPromise(
      Effect.flip(run('list', { env: {}, store: () => fakeStore([]), fs: emptyFs() })),
    )
    for (const n of CREDENTIAL_NAMES) expect(out.message).toContain(n)
  })
})

describe('run', () => {
  it('builds the client against the R2 endpoint with region auto', async () => {
    const built: StoreConfig[] = []
    await Effect.runPromise(run('list', { env: SECRETS, store: (c) => (built.push(c), fakeStore([])), fs: emptyFs() }))
    expect(built.map((c) => [c.endpoint, c.region])).toEqual([
      ['https://acct-placeholder-1.r2.cloudflarestorage.com', 'auto'],
    ])
  })

  it('follows continuation tokens and reports each path', async () => {
    const fs = emptyFs({ 'a.png': 'a' })
    const pages = [[{ key: 'a.png', etag: `"${md5('a')}"` }], [{ key: 'b.png', etag: '"x"' }]]
    const report = await Effect.runPromise(run('list', { env: SECRETS, store: () => fakeStore(pages), fs }))
    expect(report.lines).toEqual([
      'both         a.png',
      'remote only  b.png',
      '1 both, 0 differs, 0 local only, 1 remote only, 0 unreadable',
    ])
  })

  it('uploads with the content type and carries on past a failed key', async () => {
    const puts: string[] = []
    const store = fakeStore([[]], puts)
    const failing: ObjectStore = {
      ...store,
      put: (k, b, ct) =>
        k === 'bad.png'
          ? Promise.reject(
              Object.assign(new Error('secret-in-message'), {
                name: 'AccessDenied',
                $metadata: { httpStatusCode: 403 },
              }),
            )
          : store.put(k, b, ct),
    }
    const fs = emptyFs({ 'bad.png': 'a', 'good.jpg': 'a' })
    const report = await Effect.runPromise(run('upload', { env: SECRETS, store: () => failing, fs }))
    expect(puts).toEqual(['good.jpg image/jpeg'])
    expect(report.failed).toBe(1)
    expect(report.lines.join('\n')).toContain('bad.png: AccessDenied HTTP 403')
    expect(report.lines.join('\n')).not.toContain('secret-in-message')
  })

  it('counts only the uploads that landed, and replaces likewise', async () => {
    const store = fakeStore([[{ key: 'old.png', etag: '"x"' }]])
    const denied: ObjectStore = {
      ...store,
      put: () => Promise.reject(Object.assign(new Error('m'), { name: 'AccessDenied' })),
    }
    const fs = emptyFs({ 'new.png': 'a', 'old.png': 'a' })
    const report = await Effect.runPromise(run('upload', { env: SECRETS, store: () => denied, fs }))
    expect(report.failed).toBe(2)
    expect(report.lines.at(-1)).toBe('0 uploaded, 0 replaced, 0 skipped, 2 failed')
  })

  it('downloads what is missing and never overwrites', async () => {
    const fs = emptyFs({ 'have.png': 'a' })
    const pages = [[{ key: 'have.png', etag: '"x"' }, { key: 'new/dir/n.png', etag: '"y"' }, { key: '../evil.png' }]]
    const report = await Effect.runPromise(run('download', { env: SECRETS, store: () => fakeStore(pages), fs }))
    expect(fs.written).toEqual(['new/dir/n.png'])
    expect(report.failed).toBe(0)
    expect(report.lines.join('\n')).toContain('refused   ../evil.png')
  })

  it('an unreadable local file does not stop download, and is never fetched over', async () => {
    const base = emptyFs({ 'locked.png': 'a' })
    const fs = {
      ...base,
      read: (k: string) =>
        k === 'locked.png'
          ? Promise.reject(Object.assign(new Error('x'), { name: 'Error', code: 'EACCES' }))
          : Promise.resolve(new Uint8Array()),
    }
    const pages = [
      [
        { key: 'locked.png', etag: '"x"' },
        { key: 'missing.png', etag: '"y"' },
      ],
    ]
    const report = await Effect.runPromise(run('download', { env: SECRETS, store: () => fakeStore(pages), fs }))
    expect(base.written).toEqual(['missing.png'])
    expect(report.failed).toBe(0)
  })

  it('an unreadable local file fails alone on upload and list', async () => {
    const puts: string[] = []
    const base = emptyFs({ 'locked.png': 'a', 'ok.png': 'a' })
    const fs = {
      ...base,
      read: (k: string) =>
        k === 'locked.png' ? Promise.reject(Object.assign(new Error('x'), { code: 'EACCES' })) : base.read(k),
    }
    const up = await Effect.runPromise(run('upload', { env: SECRETS, store: () => fakeStore([[]], puts), fs }))
    expect(puts).toEqual(['ok.png image/png'])
    expect(up.failed).toBe(1)
    expect(up.lines.join('\n')).toContain('locked.png: Error EACCES')
    const ls = await Effect.runPromise(run('list', { env: SECRETS, store: () => fakeStore([[]]), fs }))
    expect(ls.failed).toBe(1)
    expect(ls.lines).toContain('local (unreadable) locked.png')
  })
})
