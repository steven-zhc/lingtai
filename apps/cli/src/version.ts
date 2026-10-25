import { isSea } from 'node:sea'

import workspace from '../../../package.json' with { type: 'json' }

/**
 * What `lingtai version` says (#185): the version, and which of the four
 * artifacts this is — a binary copies the Node that built it, so the platform
 * is part of what was shipped, not a detail of the machine.
 *
 * The version is the workspace's, read at import: from the source that is the
 * checkout's `package.json`, and bundled it is inlined by esbuild, so the binary
 * reports the version it was built at.
 */
export function platformName(platform: string = process.platform, arch: string = process.arch): string {
  return `${platform === 'darwin' ? 'macos' : platform}-${arch}`
}

/** The facts the line and `--json` both say, so the two cannot drift apart (#616). */
export function versionFacts(): { lingtai: string; platform: string; form: 'binary' | 'script'; node: string } {
  return {
    lingtai: workspace.version,
    platform: platformName(),
    form: isSea() ? 'binary' : 'script',
    node: process.version,
  }
}

/** Parsed by `upgrade` from a *different* binary (`versionRuns`): first word `lingtai`, second the version. */
export function versionLine(): string {
  const { lingtai, platform, form, node } = versionFacts()
  return `lingtai ${lingtai} ${platform} (${form}, node ${node})`
}
