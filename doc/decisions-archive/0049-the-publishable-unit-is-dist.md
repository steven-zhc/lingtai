# 0049 — The publishable unit is `dist/`, and both workspace manifests stay private

**Status** accepted · 2026-09-17 · qualifies [0010](0010-source-runs-unbuilt.md) for distribution only ·
qualifies [0035](0035-the-site-is-a-projection.md)'s *built by `pnpm build`*

## Context

`#183`: the root `package.json` and `apps/cli/package.json` were both
`"private": true`, and there was no release — you cloned the repository and ran
`node apps/cli/src/lingtai.ts`. The 1.0 plan (`doc/design/1.0.md`) ships a
tarball, then a SEA binary, then keeps an npm package as the escape hatch; all
three need one thing that can be built.

0010 says the source runs unbuilt. It governs **development** and says nothing
about distribution, and `packages/hook` has been a compiled Bun binary since
0002, so a build for shipping contradicts nothing.

## Decision

**`pnpm build` writes `dist/`, and `dist/` is the package.**

```
dist/
  package.json   generated: name `lingtai`, bin `lingtai.cjs`, no dependencies, not private
  lingtai.cjs    the CLI, one CommonJS file (esbuild)
  board/         the board as Next `standalone`; entry board/apps/board/server.js
```

**Neither existing manifest stops being private, and that is the decision, not
an omission.** Unmarking either would publish the wrong thing:

- The **root** is the workspace. Published, it is the monorepo's manifest with
  every package's source behind it and nothing runnable at its `bin`.
- **`apps/cli`**'s `bin` is `./src/lingtai.ts`, and its dependencies are
  `workspace:*` names that exist on no registry. Published, it installs and
  fails on the first import.

The generated manifest has nothing to install because the bundle and the
standalone board already hold what they load. `apps/release` builds it and
tests it; it is itself private, because a build tool is not the product.

**The CLI is CJS because a SEA's main is**, and the board's `server.js` is ESM
because its package is `"type": "module"`. `lingtai board` crosses with
`import()`, never `require()`, and the test starts the board through the bundle
rather than asserting a path exists.

**The board is pure JavaScript.** `images: { unoptimized: true }` — the board
renders `next/image` nowhere — and the build prunes `sharp` and `@img/*`, which
Next's own server trace copies regardless. `outputFileTracingExcludes` was tried
and left `sharp-darwin-arm64.node` in place. The build refuses to finish with a
`.node` file in `board/`, and the test checks the same.

**Two builds of one commit give one layout.** Next's build id is a directory
under `.next/static/` and random by default; `pnpm build` sets it to the commit.

## Consequences

- `pnpm build` no longer runs every package's `build`. The hook binary is
  `pnpm --filter @lingtai/hook build`, as `doc/operating.md` already said, and
  the site's static export is `pnpm --filter @lingtai/site build` — which
  qualifies 0035's *built by `pnpm build` like everything else*.
- `pnpm test` now includes two board builds (`apps/release`), about 15s warm.
- The bundle's `import.meta.url` is the bundle's own, so the build tells
  `@lingtai/env` it is bundled and it looks for `.env.local` one directory above
  `lingtai.cjs` — the checkout root when `dist/` is the one `pnpm build` wrote.
  The test starts the bundle with the URL only in that file. Where an installed
  CLI reads its configuration is the installer's question
  (`~/.lingtai/config.yml`, 1.0 step 9), and nothing here answers it.
- Next copies the whole of `apps/board` — `src/` and `test/` too — into
  `standalone`, because Turbopack warns that dynamic filesystem reads trace the
  whole project. Harmless, and a size to trim later.
