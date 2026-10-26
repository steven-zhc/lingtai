/**
 * Writes `doc/cli.json` and `doc/cli.md` from the command definitions and the
 * parser (#545) — the counterpart of `scripts/the-pass.py`. Run: `pnpm docs:cli`.
 * `apps/cli/unit/cli-doc.test.ts` fails when what is committed differs.
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { cliManifest, renderCliPage, renderManifest } from '../apps/cli/src/cli-doc.ts'

const doc = fileURLToPath(new URL('../doc/', import.meta.url))
const manifest = cliManifest()
writeFileSync(`${doc}cli.json`, renderManifest(manifest))
writeFileSync(`${doc}cli.md`, renderCliPage(manifest))
