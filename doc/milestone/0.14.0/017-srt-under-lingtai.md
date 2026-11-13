# 017 — Does sandbox-runtime hold an agent the way 0.14 needs?

**Run** 2026-11-12 (Codex on Linux re-run the same day, after a fresh login) · **Result** yes, with five things to build around and three
for the operator to decide. This is the measurement
[0.14.md](0.14.md) puts first (S1). It was made by hand, before any
ticket, on two machines. Nothing in the product changed.

| | harbor | foundry |
|---|---|---|
| OS | Linux Mint 22.2 (Ubuntu 24.04 base), kernel 6.8, x86_64 | macOS 15.7.7, x86_64 |
| sandbox | bubblewrap 0.9.0, socat, rg | Seatbelt (`sandbox-exec`), rg |
| `kernel.apparmor_restrict_unprivileged_userns` | `0` (already off on this machine) | — |
| Node | 24.20.0 | 26.13.0 |
| Claude Code | 2.1.278 | 2.1.312 |
| Codex | 0.92.0 installed; **0.167.2** installed under `~/srt-probe` and measured (0.92.0 is refused by the service for every model) | 0.163.0 |
| srt | `@anthropic-ai/sandbox-runtime` 0.0.82, installed under `~/srt-probe`, outside every writable path | same |

## What was run

A stand-in for `~/.lingtai` was built under `~/srt-probe/lt`: a `config.yml`
canary, a bare mirror `repos/demo.git` and a worktree `worktrees/demo-1` added
from it, the way Lingtai lays them out. Every check ran with
`srt --settings <file> -c '<command>'` from inside the worktree, and printed
only an exit status and the last line of output, never a file's contents. The
real `~/.lingtai/config.yml` was never read.

The policy is the one in 0.14.md, made concrete:

```json
{
  "network": {
    "allowedDomains": ["api.anthropic.com", "*.anthropic.com", "claude.ai", "*.claude.ai",
      "sentry.io", "*.sentry.io", "api.openai.com", "*.openai.com", "chatgpt.com", "*.chatgpt.com",
      "registry.npmjs.org", "*.npmjs.org", "github.com", "*.github.com", "*.githubusercontent.com"]
  },
  "filesystem": {
    "denyRead": ["~/.ssh", "~/.aws", "~/.config/gh", "~/.gnupg", "~/.netrc", "~/.docker/config.json",
      "~/.kube", "~/.npmrc", "~/.lingtai/config.yml", "<lt>"],
    "allowRead": ["<lt>/worktrees/demo-1", "<lt>/repos/demo.git"],
    "allowWrite": ["<lt>/worktrees/demo-1", "<lt>/repos/demo.git", "/tmp", "/private/tmp", "$TMPDIR",
      "~/.claude", "~/.claude.json", "~/.codex"]
  }
}
```

Three variants differ only in Unix sockets: none, `allowUnixSockets: [<the
socket>]`, and `allowAllUnixSockets: true`.

## Results

### The boundary itself

| Check | Want | Linux | macOS |
|---|---|---|---|
| `~/.ssh`'s entries visible | no | no (an empty directory) | no (`Operation not permitted`) |
| the `config.yml` canary readable | no | no (hidden) | no |
| the worktree, under the denied `lt`, readable | yes | yes | yes |
| `~/.claude/.credentials.json`, `~/.codex/auth.json` readable | yes | yes | yes |
| write to `$HOME` | no | no (`Read-only file system`) | no |
| write in the worktree | yes | yes | yes |
| `git commit` in the worktree (writes the mirror) | yes | yes | yes |
| `git add -A` in the worktree | yes | **no** (below) | yes |
| `api.anthropic.com`, `registry.npmjs.org` | yes | yes | yes |
| `example.com` | no | no | no |
| raw TCP to `1.1.1.1:443` | no | no | no |
| a Unix socket under `$TMPDIR/lingtai/`, no allowance | — | `EPERM` | `EPERM` |
| the same, `allowUnixSockets: [path]` | yes | **no** | yes |
| the same, `allowAllUnixSockets: true` | yes | yes | yes |

**Deny-then-allow under `~/.lingtai` works on both platforms.** A run can be
given its own worktree and mirror while the rest of the directory is hidden, so
the trap 0.14.md named first is answered by configuration.

### Holes in the policy as written

| Check | Linux | macOS | Why it matters |
|---|---|---|---|
| write a file in `~/.claude` | **yes** | **yes** | `~/.claude/settings.json` holds hooks. A run that writes a hook there has code run by the operator's next Claude Code session, outside any sandbox. |
| `git config --local` in the worktree (writes the mirror's `config`) | **yes** | **yes** | `core.hooksPath` or `core.fsmonitor` in the mirror's config runs a program the next time Lingtai runs git there, and Lingtai's git runs outside the sandbox. srt only protects a file named `.git/config`; a bare mirror's `config` is not one. |

Neither is srt's fault: both directories were granted write in the policy. Both
need write denies inside the grant (below).

### Nesting

| | Linux | macOS |
|---|---|---|
| `sandbox-exec` inside srt | — | **fails**, `sandbox_apply: Operation not permitted` |
| `codex sandbox macos -- true` inside srt | — | **fails**, the same, rc 71 |
| `bwrap` inside srt | **fails**, `No permissions to create new namespace` | — |
| `codex sandbox linux -- true` inside srt | runs (rc 0; Codex uses Landlock, not a namespace) | — |
| `codex exec --sandbox workspace-write` inside srt, told to write a file in the worktree | **cannot write** (it answered `FAILED`; no file) | — |

So a runtime's own sandbox does not work inside srt on either platform: on
macOS it cannot start, and on Linux Codex's starts but then cannot write even
in the worktree. That is decision 1 in 0.14.md.

### The agents

| Run | Linux | macOS |
|---|---|---|
| `claude -p` inside srt | **OK** | **OK**, once the token was fresh (below) |
| Claude told to `cat` the canary and `touch ~/…` with `bypassPermissions` | both failed; it reported the file as absent and the write as `Read-only file system` | — |
| `codex exec --sandbox danger-full-access` inside srt | **OK** (0.167.2) | **fails**: `workspace routing discovery failed` with `chatgpt.com` allowed |
| Codex told to `cat` the canary and `touch ~/…` | both failed, `READ=1 WRITE=1` | — |
| the same with `enableWeakerNetworkIsolation: true` | — | **OK** |

- **Codex on macOS needs `trustd`.** It verifies TLS through the system's
  Security framework, and srt's profile shuts `com.apple.trustd.agent` unless
  `enableWeakerNetworkIsolation` is set. srt's README calls that option *a
  potential data exfiltration vector through the trustd service*.
- **Claude Code's first run inside srt on macOS failed with a 401**,
  `OAuth access token has expired`, while the same command outside succeeded.
  After that outside run refreshed the token, every run inside succeeded. So a
  sandboxed Claude Code may not be able to refresh its own token, and a daemon
  whose only Claude Code runs are sandboxed may lose its login after the token
  expires. It was reproduced the same day and explained (below, *Claude
  Code's token inside srt*).
- With `--debug`, Claude Code inside srt reached `api.anthropic.com` and
  `mcp-proxy.anthropic.com`. It was refused `mcp.*` hosts for the operator's
  own connectors and a Datadog intake host. The run still succeeded.

### The build: Lingtai's own suite

`origin/main` at `8abc8613`, cloned into the stand-in worktree, on harbor.

| | Result |
|---|---|
| `pnpm install --frozen-lockfile` inside srt | **fails**: `ENOENT … mkdir '~/.local/share/pnpm/store/v11'`, the shared store is not writable |
| the same, with `~/.local/share/pnpm` and `~/.cache` writable | OK |
| `pnpm test` outside srt | 504 passed, 1 failed, 453 s |
| `pnpm test` inside srt | 503 passed, 2 failed, 433 s |

- The failure in both is `apps/cli/unit/doctor.test.ts` *fails no row*. It is
  harbor's: Node 24 is below the floor `.node-version` names.
- **The one failure only inside srt is
  `packages/conductor/unit/conduct-before-the-claim.test.ts` *refuses before
  the claim when runtime.agent is not the runtime it was handed*.** It times
  out at 20 s inside srt twice out of two runs, and the file passes outside in
  8 s. `--debug` showed no denial. The cause was found the same day (below,
  *The test that fails only inside srt*).

### Two things the build gate has to work around

- **On Linux, srt puts `/dev/null` stand-ins into the worktree** for the paths
  it always protects: `.bashrc`, `.bash_profile`, `.gitconfig`, `.gitmodules`,
  `.idea`, `.mcp.json`, `.profile`, `.ripgreprc`, `.vscode`, `.zprofile` and
  `.zshrc`. They show as untracked while the command runs, and `git add -A`
  then fails with `can only add regular files`. They are gone from the host
  afterwards. **Writing those names into the mirror's `info/exclude` from
  outside the sandbox fixes it**: with that, `git add -A && git commit` inside
  srt committed the one real file.
- **A package manager's shared store must be writable**, and so it is shared
  between every sandboxed run and the operator's own installs.

### What srt reports

Measured through the library: `SandboxManager.wrapWithSandbox(cmd, …,
{ commandId })`, then
`getSandboxViolationStore().getViolationsForCommand(commandId)`.

| Refused | Linux | macOS |
|---|---|---|
| a connection | 1 violation, `deny network-outbound example.com:443 (host is not on the allow list)` | the same |
| a read of the canary, of `~/.ssh` | 0 | 0 |
| a write to `$HOME` | 0 | 0 |

macOS's own log held 27 `Sandbox` deny lines from those two minutes, so the
kernel saw the file denials. srt did not attribute them to the command through
this API. Linux has no file-violation report at all (srt's README:
*Bubblewrap doesn't provide built-in violation reporting*).

### Bundling into the single binary (0113)

Read from the package, not built:

- 166 MB of the 180 MB install is Windows-only: `@microsoft/mxc-sdk`,
  `node-pty` and `koffi`. srt loads it through one dynamic `import()`
  (`dist/sandbox/mxc-sandbox-utils.js:98`), so a bundle can leave it out.
- On Linux srt runs a 742 KB static `apply-seccomp` binary, which it finds
  relative to its own file (`dist/sandbox/generate-seccomp-filter.js:119-123`).
  Corrected 2026-11-13: with `allowAllUnixSockets: true` srt skips the seccomp
  filter entirely (0.0.83 `linux-sandbox-utils.js`, *Skipped when
  allowAllUnixSockets is true*), so Lingtai never runs it; a bundle that copies
  `vendor/` beside itself lets srt's own lookup find it and the Java proxy jar.
- `bwrap`, `socat` and `rg` on Linux, and `rg` on macOS, stay host
  requirements.


## The test that fails only inside srt

Found on 2026-11-12, on harbor, after the run above.

**A unit test spawns the machine's real `claude` and `codex`.** The test's
recipe names `codex` at `runtime.agent` while the conductor dispatches
`claude-code`
(`packages/conductor/unit/conduct-before-the-claim.test.ts:299-316`). That
puts `codex` among the second runtimes, so `runOnce` asks the real probe
before it refuses:

    const secondRuntimes = new Set<RuntimeId>(runtimesOf(recipe).filter((r) => r !== ownRuntime))
    const dispatchable: readonly string[] =
      secondRuntimes.size === 0
        ? []
        : yield* Effect.promise<readonly RuntimeId[]>(() => (options.signedIn ?? signedInHere)())

(`packages/conductor/src/conduct.ts:851-856`). `signedInHere` spawns
`claude auth status` and `codex login status` with `runnableEnv({})`
(`packages/conductor/src/projects.ts:100-114`), and each probe waits up to
20 s (`packages/agent/src/auth.ts:110`). That is the test's own timeout. The
option that keeps it out says what it is for: *A unit test that names one
runtime never reaches it, which is what keeps the probe out of the half of the
suite that may not spawn (0060 §1)* (`conduct.ts:516-520`). The two tests
beside it pass `signedIn: async () => []` (`:359`, `:408`). This one does not.
The refusal it asserts is on `runtime.agent` and needs no probe at all
(`agentRefusal`'s first branch, `conduct.ts:432-440`).

**Why the probe hangs inside srt.** `runnableEnv` keeps `HOME`, `LANG`,
`LOGNAME`, `PATH`, `TMPDIR` and `USER`, so it drops the proxy variables srt
sets (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and their lower-case forms).
On Linux the proxy is the only way out of the sandbox's network namespace.
Measured inside srt:

| `claude auth status` (2.1.278) | |
|---|---|
| full environment | 2.7 s |
| `PATH` and `HOME` only | **no answer; killed at 40 s** |
| `PATH`, `HOME` and the proxy variables | 2.9 s |
| `curl` with `PATH` and `HOME` only, for comparison | fails in 0.3 s (cannot resolve) |

Lingtai's own probe inside srt gave the same: `claude` took 20,012 ms and
returned *`claude auth status` did not answer in 20s*. Outside srt it took
2,075 ms. `codex login status` answered in about 90 ms both ways.

**Why it stayed hidden.** Outside a sandbox the probe answers in a second or
two. On a machine without the binaries it fails at spawn at once. Either way
the test is green, and nothing notices that a unit test started two
processes. On harbor it also costs every `pnpm test` about 2 s. This
`claude auth status` (2.1.278) even reaches the API: it answered with an API
error rather than a sign-in state.

**What it means beyond the test.** Anything Lingtai spawns with a filtered
environment from inside a sandbox loses the network: a Lingtai under test in
the build gate, or a Lingtai that runs inside a sandboxed step. So the
product's wrap has to be applied after the environment is filtered, with srt's
variables added by the wrap. The policy module (S3) must hold that order.

## Claude Code's token inside srt

Measured 2026-11-12 on foundry, Claude Code 2.1.312, credentials in
`~/.claude/.credentials.json`. Each case ran on a copy of the credentials in
its own `CLAUDE_CONFIG_DIR`, with the copy's `expiresAt` set an hour in the
past, so that Claude Code would try to refresh. Only expiry times and the
first 8 hex digits of each token's SHA-256 were printed.

| Case | Result |
|---|---|
| A: expired copy, inside srt, today's allowlist | answered OK on the still-valid access token; the refresh was **refused**: `Connection blocked to platform.claude.com:443`; the copy was unchanged |
| B: the same, with `claude.com` and `*.claude.com` allowed | refreshed inside srt: the copy got a new access and refresh token, valid 480 min |
| C: after B, a fresh expired copy of the **real** file, outside srt | `OAuth session expired and could not be refreshed` |
| the real login, outside srt, 213 min of its access token left | **the same failure**, and Claude Code then cleared the tokens from the real file |
| D: a copy holding only the access token (no refresh token), inside srt, no `claude.com` | OK |
| E: D, marked expired | OK. With no refresh token there is nothing to try, and the access token was still valid |
| F: `claude auth status` on an expired full copy, outside srt | `"loggedIn": true`, and the copy got new tokens. It is **a refresh with no model call** |

**What this establishes.**

- **The 401 seen earlier was a refused refresh.** Refreshing needs
  `platform.claude.com`, and the allowlist had `claude.ai` and
  `*.anthropic.com` but not `claude.com`.
- **A refresh rotates the refresh token and revokes the old access token.**
  After B, the operator's own login failed at once, though its access token
  had more than three hours left. So **a run that refreshes in a directory of
  its own logs the operator out**, and every other run sharing that login
  with them. Writing the new tokens back afterwards cannot be done
  atomically: any session that used the old token in between has already
  failed. B did break foundry's real login. It was restored by writing B's
  tokens into the real file, and the real login answered OK again.
- **A run does not need the refresh token.** With only the access token
  (D), Claude Code works inside srt. Tokens here last 480 min, and a run's
  wall limit is 60 min.
- **The refresh can happen outside, for free.** `claude auth status`
  refreshes an expired token without a model call (F).

So decision 8 becomes: **before each Claude Code run, Lingtai refreshes the
operator's own login outside the sandbox if it expires within the run's wall
limit plus a margin, using `claude auth status` against the operator's own
configuration. Then it copies only the access token into the run's
directory.** A run can neither rotate the operator's login nor carry away a
long-lived refresh token, and `claude.com` stays off the allowlist.

Linux was not measured: harbor's Claude Code is 2.1.278, older than the one
measured here.

## Claude Code's login in the macOS Keychain

Measured 2026-11-12 on foundry, Claude Code 2.1.312, in Terminal inside the
desktop session (over VNC). Over SSH the Keychain answers *User interaction is
not allowed*, and `launchctl asuser` into the desktop session needs root, so
this part could only be run by hand. Only expiry times and token hash
prefixes were printed.

foundry holds two logins for one user. `~/.claude/.credentials.json` is valid,
with 271 minutes left. The Keychain item `Claude Code-credentials` (account
`steven`) was last written in January and expired 413,515 minutes (287 days)
before the test.

| Step, in the desktop session | Result |
|---|---|
| Is the login Keychain unlocked? | yes, `no-timeout` |
| `security find-generic-password -s "Claude Code-credentials" -w` | **read the item, no dialog**, exit 0 |
| `claude auth status` | `"loggedIn": true`, on the January token. Neither store changed. |
| `claude -p` | `OAuth session expired and could not be refreshed`. Claude Code then **cleared the Keychain item's tokens** (item rewritten 2026-11-13 03:25:19Z, `at=none rt=none`). |
| `~/.claude/.credentials.json` across all four steps | untouched: same mtime, same tokens |

**What this establishes.**

- **The store depends on the session, not the machine.** In the desktop
  session Claude Code reads the Keychain and ignores the file, even though the
  file holds a valid login. Over SSH it reads the file. `lingtai service`
  installs a LaunchAgent and starts the daemon in `gui/<uid>`
  (`apps/cli/src/service.ts:357`, `:860`), so a daemon started that way reads
  the Keychain like the desktop session does. A daemon started from an SSH
  shell reads the file. The same machine can therefore give two different
  answers to whether it is signed in.
- **`"loggedIn": true` does not mean a run will work.** `claude auth status`
  answered true on a token expired for 287 days, whose refresh then failed. It
  reports that credentials exist, not that they are valid. Lingtai's doctor
  probe (`signedInHere`) and the refresh step in decision 8 both read that
  field.
- **Any process in the desktop session can read the login.** `security`
  read the item with no prompt. The item's access list lets `security` read
  it, presumably because Claude Code writes the item through `security`
  itself. Whether a process **inside srt** can still reach it goes through
  `securityd` over Mach IPC, not through a file, so the filesystem deny list
  says nothing about it. That is measured next.
- **A failed refresh clears the store it came from**, in the Keychain as in
  the file (above). The desktop login on foundry was already unusable before
  the test, and it is now empty.

A second script ran in the same desktop session four minutes later. G1 and G2
use a directory holding only the file's access token, as in D. G3 and G4 run
`security find-generic-password -s "Claude Code-credentials" -w` inside srt
with D's policy.

| Case, in the desktop session | Result |
|---|---|
| G1: `CLAUDE_CONFIG_DIR` holding only an access token, outside srt | **OK**. It used the directory's file. No new Keychain item appeared, and the empty `Claude Code-credentials` item did not stop it. |
| G2: the same, inside srt | **OK**. The copy was unchanged and no Keychain item appeared. |
| G3: `security` reads the Keychain item, inside srt | **exit 0: read.** The deny list as written leaves the operator's login readable to a run. |
| G4: G3 with `~/Library/Keychains` on `denyRead` | **exit 44** (`errSecItemNotFound`): refused. |

**What this establishes.**

- **A run's own directory sidesteps the Keychain.** With `CLAUDE_CONFIG_DIR`
  set, Claude Code reads that directory's file in the desktop session too.
  Decision 8's shape works on macOS whichever session the daemon runs in. Only
  the step that *reads the operator's login* has to know which store holds
  it.
- **The macOS deny list needs `~/Library/Keychains`.** Without it, any
  command inside srt can read every Keychain item whose access list allows
  `security`, and Claude Code's login is one of them. Denying the directory
  works because the client opens the keychain file itself. It also cuts off
  git's `osxkeychain` credential helper, which a run has no business using
  (decision 5).
- **Not measured:** G2 with `~/Library/Keychains` denied, which is S4's
  configuration. G1 shows that a run with its own directory does not ask the
  Keychain for its token, so it is expected to work, and S4's Done when checks
  it. Also not measured: whether `claude auth status` refreshes a
  *refreshable* token held in the Keychain. The only Keychain token on foundry
  had a dead refresh token, and `auth status` neither refreshed it nor said
  so.

## One srt per process: can a run read another run's network id?

Measured 2026-11-13 through the library, on both machines, srt 0.0.82. One
`SandboxManager` is initialised with no allowed domain. Two ids of 16 random
bytes are registered with `registerCommandNetworkLists`: A may reach
`example.com`, B may reach nothing. A is wrapped and started (`curl
example.com; sleep 20`), and four seconds later B is wrapped and run in the same
worktree. B dumps every process it can see into a file, and the probe outside
looks for A's id in it, in four encodings. As a control, the same search for
B's own id must find it.

| | harbor (Linux) | foundry (macOS) |
|---|---|---|
| A reaches `example.com` under its own id | 200 | 200 |
| B reaches it under its own id | refused (`000`) | refused (`000`) |
| processes B can see | 5 (its own; bwrap gives it a PID namespace) | 683 by `proc_listallpids`; `ps` is refused (`/bin/ps: Operation not permitted`) |
| other processes' command lines | none visible | **399 readable** through `sysctl(KERN_PROCARGS2)` from Python, A's `bash -c 'curl …; sleep 20'` included; 284 refused with `EINVAL` |
| other processes' environment | none visible | **empty**: A's block has its argv and no environment |
| B finds its own id (control) | yes | yes |
| B finds A's id | **no** | **no** |

So a run did not learn another run's id on either platform. **That is not
because the id stays out of command lines; it does not.** `wrapWithSandbox`
returns one shell string that sets the proxy variables inline, id and proxy
token included (`env HTTP_PROXY=http://srt.<id>…:<token>@localhost:<port> …`
on macOS, `bwrap … --setenv HTTP_PROXY …` on Linux), and
`wrapWithSandboxArgv` is only that string behind `<shell> -c`, returned with
the calling process's whole environment
(`dist/sandbox/sandbox-manager.js:2448-2450`). The id is in the command line
of the `bash -c` and of `env` or `bwrap` for the moment before each execs the
next. On Linux no run sees another's processes at all (PID namespace). On macOS
a run reads command lines, so a run that polls the process table could catch
another run's id in that moment. The probe above did not, and what the id
would give is the other project's allowlist, not a way past the sandbox. That
residual is accepted and said in the manual.

Two rules follow for Lingtai. **The `env` that `wrapWithSandboxArgv` returns is
never passed to `spawn`**: it is the daemon's own environment, Lingtai's
database URL included. The child gets Lingtai's filtered environment and srt's
proxy variables, nothing else. And the argv is spawned with `shell: false`.

The same row says something wider: **on macOS, a sandboxed run can read the
command line of the operator's other processes.** A secret passed as an
argument to any process the operator runs is readable from inside srt. The
environment is not. The safety manual says so (S12).

## srt 0.0.83

Re-run 2026-11-13 on both machines, because 0.14 pins 0.0.83 rather than the
0.0.82 measured above. The same library probes, the same configuration, 0.0.83
installed beside 0.0.82 under `~/srt-probe-83`:

| | harbor | foundry |
|---|---|---|
| `~/.ssh` (6 entries outside) | empty inside (Linux mounts an empty directory over a denied one, so `ls` exits 0 and lists nothing) | empty inside; `cat` refused |
| the `config.yml` canary | refused | refused |
| a write outside the writable roots | refused | refused |
| `example.com`, off the allowlist | refused, 1 violation reported | refused, 1 violation reported |
| per-run lists: A allowed, B not | A 200, B refused | A 200, B refused |
| B finds A's id | no | no |

Every row matches 0.0.82. `registerCommandNetworkLists` and
`wrapWithSandboxArgv` are in 0.0.83's API unchanged.

## The hook sockets' directory, write-denied

Measured 2026-11-13 on both machines, srt 0.0.83. A server outside srt listens
on `<tmpdir>/lingtai/probe-<pid>.sock`, as Lingtai's hook does. The temp
directory is writable to the run, and `<tmpdir>/lingtai` is on `denyWrite`
(on macOS both the `/var/folders/…` path and its real path). Linux uses
`allowAllUnixSockets`, macOS `allowUnixSockets: [<the socket>]`.

| inside srt | harbor | foundry |
|---|---|---|
| connect to the socket | `pong` | `pong` |
| write a file beside it | `Read-only file system` | `Operation not permitted` |
| `rm` the socket | refused; still on disk | refused; still on disk |
| bind a new socket in that directory | `EROFS` | `EPERM` |
| write elsewhere in the temp directory (control) | written | written |

So write-denying the directory keeps the hook working and stops one run from
removing or replacing another run's socket. It does not stop a run from
connecting to another run's socket on Linux, where `allowAllUnixSockets` lets
every socket through (decision 7).

## Two srt options are per process, not per command

Read in 0.0.83's `sandbox-manager.js`: `allowUnixSockets`,
`allowAllUnixSockets` and `enableWeakerNetworkIsolation` are read from the
instance's configuration (`getAllowUnixSockets`, `getAllowAllUnixSockets`,
`getEnableWeakerNetworkIsolation`), and a command's `customConfig` cannot
change them. With one instance per process, every run gets the same socket
rule and, on macOS, the same weaker network isolation. That is why decision 9
now turns it on for every macOS run.

## What this changes in 0.14.md

1. **The hook socket on Linux needs `allowAllUnixSockets`.** seccomp cannot
   filter by path, so the only setting that lets the hook through lets every
   Unix socket through. This includes `/var/run/docker.sock` when the operator
   can reach it. That is an operator decision (below).
2. **The writable runtime directories need write denies inside them**: at
   least `~/.claude/settings*.json`, `~/.claude/hooks`, `~/.claude/plugins` and
   `CLAUDE.md`, and the `mcpServers` that `~/.claude.json` can carry.
   `~/.claude.json` is rewritten by Claude Code on every run, so it cannot
   simply be read-only. This also needs a decision.
3. **The mirror's `config`, `hooks/` and `info/` are not writable from a
   run.** Lingtai writes `info/exclude` itself, from outside, at provision.
4. **Codex on macOS needs `enableWeakerNetworkIsolation`.** This is a decision.
5. **S8 records refused connections only.** That works on both platforms.
   File refusals are not reported on Linux and not attributed on macOS.
6. **A run never refreshes Claude Code's token.** Lingtai refreshes the
   operator's login outside srt when it is close to expiry
   (`claude auth status`), and gives the run only the access token. It reads
   the operator's login from the store that session's Claude Code uses (the
   Keychain in the desktop session, the file over SSH), and it judges the login
   by `expiresAt`, never by `"loggedIn"`.
7. **The build gate needs the package stores writable**, and Lingtai's own
   `pnpm test` must be green inside srt before Lingtai opts in. The one test
   that is not is a test bug: it spawns the real runtimes (above). It is fixed
   on its own, before S6.
8. **The wrap goes outside the environment filter.** srt's proxy variables
   are added after `runnableEnv` has chosen what a run gets, or every network
   call a run makes hangs on Linux.
9. **Bundling is feasible**: `vendor/` copied beside the bundle, nothing extracted at start (corrected above).
10. **On macOS the deny list includes `~/Library/Keychains`**, or a run can
    read the operator's Claude Code login through `security`.
11. **A project's allowlist is registered per run.** One srt per process;
    each wrap registers its project's list under a random id. The id is
    briefly in a command line (srt puts it there); on macOS a run reads other
    processes' command lines, so another project's allowlist is the residual,
    accepted. The `env` srt returns is never the child's environment (above).

## Not measured

- A real Lingtai attempt: the hook, `guarded`'s fail-closed and the run log
  under srt. The socket test stands in for the hook.
- Ubuntu 24.04's default AppArmor setting, since harbor already has it off.
  srt's README says bubblewrap needs it off or a profile granting `userns`.
- `claude auth status` refreshing a refreshable token held in the macOS
  Keychain (above).
- An arm64 machine.
