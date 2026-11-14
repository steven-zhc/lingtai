/**
 * What a host needs installed before srt can sandbox a command, and the command that installs it (#1159).
 * One table, here and not in `apps/cli`: doctor's `sandbox: host` row reads it, and so does the setup wizard
 * (#1160). srt-free, like `host.ts`, so a caller reads it without loading srt's module graph.
 */
export interface InstallAdvice {
  /** The programs srt looks for and a stock host may lack. */
  readonly missing: readonly string[]
  /** A command a person can run as written. */
  readonly command: string
}

const TABLE: Readonly<Record<string, InstallAdvice>> = {
  linux: {
    missing: ['bwrap', 'socat', 'rg'],
    command: 'sudo apt install bubblewrap socat ripgrep   # or: sudo dnf install bubblewrap socat ripgrep',
  },
  darwin: { missing: ['rg'], command: 'brew install ripgrep' },
}

/** What to install on `platform`, or `undefined` for one that cannot be sandboxed at all. */
export const installFor = (platform: string): InstallAdvice | undefined => TABLE[platform]
