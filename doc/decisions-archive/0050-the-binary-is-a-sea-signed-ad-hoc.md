# 0050 — The binary is a SEA built on its own platform, signed ad hoc, and run before it is published

**Status** accepted · 2026-09-17 · builds on [0049](0049-the-publishable-unit-is-dist.md)

## Context

`#185`: 0049's `dist/` still needs a Node on the machine. `doc/design/1.0.md`'s
step 10 is the binary — one file with Node inside it — and the installer
(`#184`) unpacks `versions/<v>/` without caring whether `lingtai` there is a
binary or a script.

## Decision

**`pnpm binary` writes `dist/lingtai` beside `lingtai.cjs` and `board/`**, with
`node --build-sea` (Node 25.5+): a copy of the building Node with the bundle
injected, and no `postject`. `apps/release/src/binary.ts`.

**Four artifacts, each built and run on its platform** —
`macos-arm64 macos-x64 linux-x64 linux-arm64` — because SEA copies the building
Node. `.github/workflows/release.yml` runs `apps/release`'s test on each (the
bundle and the binary both start the board and serve a page) and then runs the
artifact itself. `board/` is not per-platform and is published once.

**`codesign -s -` on macOS, always.** Injection leaves the file unsigned, and
on Apple Silicon the kernel kills an unsigned binary at `exec` — status 137,
nothing on stderr, no dialog. Measured on this machine before it was written
down. The test builds one with `sign: false` and asserts `SIGKILL`, so the step
cannot be dropped quietly. A Developer ID and notarisation are for browser
downloads, which `curl | sh` is not.

**Two things a SEA changes about the bundle, both measured:**

- **`__filename` is the build machine's path**, compiled in. So the bundle's
  banner makes `import.meta.filename` `process.execPath` inside a SEA, and
  `board/` and `.env.local` are found beside the binary rather than in the
  checkout that built it.
- **`import()` in a SEA reaches built-in modules only** (`No such built-in
  module: file:///…/server.js`). `lingtai board` compiles its `import()` in a
  `vm.Script` with `USE_MAIN_CONTEXT_DEFAULT_LOADER`, which Node marks
  experimental; the binary's `execArgv` turns that one warning category off.
  Outside a SEA it is a plain `import()`, as 0049 said.

**`lingtai version` names the artifact**: version, platform, binary or script,
and the Node running it — `lingtai 0.0.0 macos-arm64 (binary, node v26.5.0)`.

**A tag `v*` publishes** the four `lingtai-<platform>.tar.gz`, `board.tar.gz`
and `SHA256SUMS` over them to GitHub Releases.

## Consequences

- Building a binary needs Node 25.5 or later; running the script does not, and
  `engines` stays `>=22`. On an older Node the binary tests skip and say so in
  their name.
- The code cache and snapshot are off: neither is needed to start, and both are
  V8's own and tied to the Node that made them.
- The binary is about 145MB, most of it Node.
- No Windows, as 1.0.md says.
