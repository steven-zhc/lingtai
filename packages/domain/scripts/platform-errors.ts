/**
 * `pnpm docs:errors`: write `doc/design/platform-errors.md`'s generated section
 * from `classify`'s table (0108 §19).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { spliceRecognised } from '../src/failure/doc.ts'

const path = fileURLToPath(new URL('../../../doc/design/platform-errors.md', import.meta.url))
writeFileSync(path, spliceRecognised(readFileSync(path, 'utf8')))
