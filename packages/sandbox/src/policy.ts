/**
 * 0.14's one sandbox policy, as data (#1146; plan: doc/milestone/0.14.0/0.14.md, measurements: experiment 017).
 *
 * Pure: every function takes the host's facts as an argument and none reads `process`, `HOME` or the disk,
 * so a test builds every path from a directory it made itself.
 */
import { posix } from 'node:path'

/** What this machine is. The live layer reads it once; a test hands one in. Every path is absolute. */
export interface HostFacts {
  /** `process.platform`. Only `darwin` and `linux` can sandbox; the check is ours because srt answers true on Windows. */
  readonly platform: string
  readonly home: string
  readonly tmpdir: string
  /** The real path of `tmpdir` where it differs (macOS: `/var/folders/…` is `/private/var/folders/…`). */
  readonly tmpdirReal?: string | undefined
  readonly stateDir: string
  readonly pnpmHome?: string | undefined
  /** The directories on the `PATH` this process started with. */
  readonly path: readonly string[]
}

/** What a project's recipe adds (S7 will pass it). Goes through the protected-path check. */
export interface ProjectAdditions {
  readonly network?: readonly string[] | undefined
  readonly write?: readonly string[] | undefined
  readonly deny?: readonly string[] | undefined
}

/** What a runtime adds for itself (S4, S5): `~/.codex`, a run's config directory. Lingtai's own, taken as given. */
export interface CallerAdditions {
  readonly write?: readonly string[] | undefined
  /** Readable and not writable: on `allowRead` and `denyWrite`, so a copy inside a `write` path stays read-only (#1150). */
  readonly read?: readonly string[] | undefined
  /** Not writable, still readable: on `denyWrite` only. */
  readonly denyWrite?: readonly string[] | undefined
  readonly deny?: readonly string[] | undefined
  readonly network?: readonly string[] | undefined
}

export interface PolicyInputs {
  readonly project: string
  readonly worktree: string
  readonly mirror: string
  readonly project_additions?: ProjectAdditions | undefined
  readonly caller_additions?: CallerAdditions | undefined
}

/** The directory in the temp dir that holds every run's hook socket: `packages/agent/src/hook-config.ts:63`. */
export const SOCKET_DIR_NAME = 'lingtai'

/** 017's list without `sentry.io` and `*.sentry.io`, which are telemetry (S8). */
export const BUILT_IN_DOMAINS: readonly string[] = [
  'api.anthropic.com',
  '*.anthropic.com',
  'claude.ai',
  '*.claude.ai',
  'api.openai.com',
  '*.openai.com',
  'chatgpt.com',
  '*.chatgpt.com',
  'registry.npmjs.org',
  '*.npmjs.org',
  'github.com',
  '*.github.com',
  '*.githubusercontent.com',
]

const unique = (xs: readonly string[]): string[] => [...new Set(xs)]

/** `<stateDir>/cache/<project>`: the policy's own (plan decision 11). */
export const cacheDir = (host: HostFacts, project: string): string => posix.join(host.stateDir, 'cache', project)

/** `<stateDir>/repos/<project>.git`: where `@lingtai/repo`'s `mirrorPathFor` puts it. Not imported, because that package reaches the event store; a unit test holds the two equal. */
export const mirrorDir = (host: HostFacts, project: string): string =>
  posix.join(host.stateDir, 'repos', `${project}.git`)

/** The hook-socket directory, under every temp spelling the host has. */
export const socketDirs = (host: HostFacts): string[] =>
  unique([host.tmpdir, ...(host.tmpdirReal ? [host.tmpdirReal] : [])].map((d) => posix.join(d, SOCKET_DIR_NAME)))

/** The built-in deny list. `stateDir` whole covers `config.yml` and every backup beside it. */
export const denyRead = (host: HostFacts): string[] => [
  posix.join(host.home, '.ssh'),
  posix.join(host.home, '.aws'),
  posix.join(host.home, '.config', 'gh'),
  posix.join(host.home, '.gnupg'),
  posix.join(host.home, '.netrc'),
  posix.join(host.home, '.docker', 'config.json'),
  posix.join(host.home, '.kube'),
  posix.join(host.home, '.npmrc'),
  host.stateDir,
  posix.join(host.home, '.claude', '.credentials.json'),
  ...(host.platform === 'darwin' ? [posix.join(host.home, 'Library', 'Keychains')] : []),
  ...(host.platform === 'linux' ? ['/var/run/docker.sock'] : []),
]

/** The temp directories a run may write: `/tmp`, `/private/tmp` on macOS, and `$TMPDIR`. */
export const tempRoots = (host: HostFacts): string[] =>
  unique([
    '/tmp',
    ...(host.platform === 'darwin' ? ['/private/tmp'] : []),
    host.tmpdir,
    ...(host.tmpdirReal ? [host.tmpdirReal] : []),
  ])

/** The mirror's own `config`, `hooks/` and `info/`: what a run could use to make git run its code. */
export const mirrorWriteDenies = (mirror: string): string[] => [
  posix.join(mirror, 'config'),
  posix.join(mirror, 'hooks'),
  posix.join(mirror, 'info'),
]

/** srt's per-command `filesystem`: complete, because a command's lists replace the instance's. */
export const filesystemFor = (host: HostFacts, input: PolicyInputs) => {
  const cache = cacheDir(host, input.project)
  const project = input.project_additions
  const caller = input.caller_additions
  return {
    denyRead: unique([...denyRead(host), ...(project?.deny ?? []), ...(caller?.deny ?? [])]),
    // allowRead overrides denyRead (017). A caller's writable path under `stateDir` has to be readable too.
    allowRead: unique([input.worktree, input.mirror, cache, ...(caller?.write ?? []), ...(caller?.read ?? [])]),
    allowWrite: unique([
      input.worktree,
      input.mirror,
      ...tempRoots(host),
      cache,
      ...(project?.write ?? []),
      ...(caller?.write ?? []),
    ]),
    denyWrite: unique([
      ...mirrorWriteDenies(input.mirror),
      ...socketDirs(host),
      ...(project?.deny ?? []),
      ...(caller?.deny ?? []),
      // srt's denyWrite overrides allowWrite, which is what makes a `read` path inside a `write` path read-only.
      ...(caller?.read ?? []),
      ...(caller?.denyWrite ?? []),
    ]),
  }
}

/** srt's per-command `customConfig`. The three instance-only settings are never here: srt does not read them from it. */
export const customConfigFor = (host: HostFacts, input: PolicyInputs) => ({
  filesystem: filesystemFor(host, input),
})

/** The domains one run registers under its id: the project's, and the caller's. Never in the instance's list. */
export const runDomains = (input: PolicyInputs): string[] =>
  unique([...(input.project_additions?.network ?? []), ...(input.caller_additions?.network ?? [])])

/** The `initialize` configuration: the built-in allowlist and the instance-only settings, nothing of a project's. */
export const instanceConfig = (host: HostFacts) => ({
  network: {
    allowedDomains: [...BUILT_IN_DOMAINS],
    deniedDomains: [] as string[],
    ...(host.platform === 'linux'
      ? { allowAllUnixSockets: true }
      : { allowUnixSockets: [posix.join(host.tmpdir, SOCKET_DIR_NAME)] }),
  },
  filesystem: { denyRead: [] as string[], allowWrite: [] as string[], denyWrite: [] as string[] },
  ...(host.platform === 'darwin' ? { enableWeakerNetworkIsolation: true } : {}),
})

/** The variables added after the caller's filtered environment: caches in the project's cache, no telemetry. */
export const policyVariables = (host: HostFacts, project: string): Record<string, string> => {
  const cache = cacheDir(host, project)
  return {
    XDG_CACHE_HOME: posix.join(cache, 'xdg-cache'),
    XDG_DATA_HOME: posix.join(cache, 'xdg-data'),
    npm_config_store_dir: posix.join(cache, 'pnpm-store'),
    npm_config_cache: posix.join(cache, 'npm'),
    PIP_CACHE_DIR: posix.join(cache, 'pip'),
    DO_NOT_TRACK: '1',
    NEXT_TELEMETRY_DISABLED: '1',
  }
}
