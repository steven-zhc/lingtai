/**
 * The two files srt finds relative to its own module (#1154).
 *
 * `vendor/seccomp/<arch>/apply-seccomp` and `vendor/java-proxy-agent/srt-proxy-agent.jar`
 * are looked up beside the bundle first, and a bundled `lingtai.cjs` carries
 * neither — so the release copies them into `dist/vendor/`, pinned by hash, and
 * srt's own lookup finds them with nothing written at start.
 *
 * `apply-seccomp` does not make the Linux sandbox hold (`allowAllUnixSockets` skips
 * the filter); shipping it removes a warning and a spawn of `npm root -g`. The jar is
 * functional: without it a JVM inside srt ignores `HTTPS_PROXY`.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/** The srt version the hashes below are for. Move it together with `packages/sandbox/package.json`. */
export const SRT_VERSION = '0.0.83'

const JAR = 'vendor/java-proxy-agent/srt-proxy-agent.jar'

export interface VendorFile {
  /** Relative to the srt package root, and to `dist/`. */
  path: string
  sha256: string
  mode: number
}

export const PINNED: Record<string, string> = {
  'vendor/seccomp/x64/apply-seccomp': '7effeb0f2d94f7b8bbb8d25a9b21fe77416e5f5c7e408cefea5a07f7560ca24a',
  'vendor/seccomp/arm64/apply-seccomp': '4fee55ac7f22dd023ba1674ff1c3fa1b502ef8121800a78ae1bc9c515091ab17',
  [JAR]: '6d3f71201e5f061eb59e00c90a68176b0438244f441970e7eff05926b241da2a',
}

/** What to copy for a platform and arch. Pure. */
export function vendorFiles(platform: string, arch: string): { files: VendorFile[]; note?: string } {
  if (platform !== 'linux' && platform !== 'darwin') {
    return { files: [], note: `no srt vendored files for ${platform}` }
  }
  const jar: VendorFile = { path: JAR, sha256: PINNED[JAR]!, mode: 0o644 }
  if (platform === 'darwin') return { files: [jar] }
  if (arch !== 'x64' && arch !== 'arm64') {
    return { files: [jar], note: `no apply-seccomp for linux ${arch}; srt supports x64 and arm64` }
  }
  const path = `vendor/seccomp/${arch}/apply-seccomp`
  return { files: [{ path, sha256: PINNED[path]!, mode: 0o755 }, jar] }
}

/** A refusal, or nothing. `read` returns the bytes at a package-relative path. */
export function checkVendor(
  version: string,
  files: VendorFile[],
  read: (path: string) => Uint8Array,
): string | undefined {
  if (version !== SRT_VERSION) {
    return (
      `srt is ${version} but the vendored hashes are pinned for ${SRT_VERSION}; ` +
      `move the hashes in apps/release/src/vendor.ts together with the pin in packages/sandbox/package.json`
    )
  }
  for (const file of files) {
    const actual = sha256(read(file.path))
    if (actual !== file.sha256) {
      return `${file.path}: sha256 is ${actual}, pinned ${file.sha256}`
    }
  }
  return undefined
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Resolve srt from `packages/sandbox`, read and check what the release ships. Throws on a refusal. */
export function readVendor(
  root: string,
  platform: string,
  arch: string,
): { files: { path: string; bytes: Uint8Array; mode: number }[]; note?: string } {
  const need = vendorFiles(platform, arch)
  const require = createRequire(join(root, 'packages', 'sandbox', 'package.json'))
  const manifest = require.resolve('@anthropic-ai/sandbox-runtime/package.json')
  const pkgRoot = dirname(manifest)
  const version = (JSON.parse(readFileSync(manifest, 'utf8')) as { version: string }).version
  const cache = new Map<string, Uint8Array>()
  const read = (path: string): Uint8Array => {
    let bytes = cache.get(path)
    if (!bytes) {
      bytes = readFileSync(join(pkgRoot, path))
      cache.set(path, bytes)
    }
    return bytes
  }
  const refusal = checkVendor(version, need.files, read)
  if (refusal) throw new Error(`srt's vendored files: ${refusal} (${pkgRoot})`)
  return {
    files: need.files.map((f) => ({ path: f.path, bytes: read(f.path), mode: f.mode })),
    ...(need.note ? { note: need.note } : {}),
  }
}
