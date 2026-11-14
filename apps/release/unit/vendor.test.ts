import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { PINNED, SRT_VERSION, checkVendor, sha256, vendorFiles } from '../src/vendor.ts'

const JAR = 'vendor/java-proxy-agent/srt-proxy-agent.jar'

describe('vendorFiles', () => {
  it('pins the three hashes for 0.0.83', () => {
    expect(SRT_VERSION).toBe('0.0.83')
    expect(PINNED).toEqual({
      'vendor/seccomp/x64/apply-seccomp': '7effeb0f2d94f7b8bbb8d25a9b21fe77416e5f5c7e408cefea5a07f7560ca24a',
      'vendor/seccomp/arm64/apply-seccomp': '4fee55ac7f22dd023ba1674ff1c3fa1b502ef8121800a78ae1bc9c515091ab17',
      [JAR]: '6d3f71201e5f061eb59e00c90a68176b0438244f441970e7eff05926b241da2a',
    })
  })

  it('gives linux its apply-seccomp at 0755 and the jar', () => {
    for (const arch of ['x64', 'arm64']) {
      const { files, note } = vendorFiles('linux', arch)
      expect(note).toBeUndefined()
      expect(files.map((f) => [f.path, f.mode])).toEqual([
        [`vendor/seccomp/${arch}/apply-seccomp`, 0o755],
        [JAR, 0o644],
      ])
    }
  })

  it('gives macOS the jar only', () => {
    expect(vendorFiles('darwin', 'arm64').files.map((f) => f.path)).toEqual([JAR])
  })

  it('says so for an unknown arch, and still ships the jar', () => {
    const r = vendorFiles('linux', 'riscv64')
    expect(r.files.map((f) => f.path)).toEqual([JAR])
    expect(r.note).toContain('riscv64')
  })

  it('ships nothing on Windows, with a note', () => {
    const r = vendorFiles('win32', 'x64')
    expect(r.files).toEqual([])
    expect(r.note).toBeDefined()
  })
})

describe('checkVendor', () => {
  const files = vendorFiles('darwin', 'arm64').files

  it('refuses another srt version', () => {
    const r = checkVendor('0.0.84', files, () => new Uint8Array())
    expect(r).toContain('0.0.84')
    expect(r).toContain('0.0.83')
  })

  it('refuses a hash that differs, naming the path and both hashes', () => {
    const bytes = new TextEncoder().encode('not the jar')
    const r = checkVendor(SRT_VERSION, files, () => bytes)
    expect(r).toContain(JAR)
    expect(r).toContain(sha256(bytes))
    expect(r).toContain(PINNED[JAR]!)
  })

  it('accepts bytes that hash to the pin', () => {
    const bytes = new TextEncoder().encode('x')
    const pinned = [{ ...files[0]!, sha256: sha256(bytes) }]
    expect(checkVendor(SRT_VERSION, pinned, () => bytes)).toBeUndefined()
  })

  it('is pinned to the version packages/sandbox depends on', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '../../../packages/sandbox/package.json'), 'utf8'))
    expect(pkg.dependencies['@anthropic-ai/sandbox-runtime']).toBe(SRT_VERSION)
  })
})
