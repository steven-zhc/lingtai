import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

// #157, #221: the board imports this module, so no file of it may load the store barrel at import. A dynamic
// `import()` (state.ts's lazy `defaultLog`) is the allowed way; a static declaration is not.
describe('@lingtai/project imports', () => {
  it('never statically imports the @lingtai/event-store barrel', () => {
    const dir = join(import.meta.dirname, '../src')
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const text = readFileSync(join(dir, file), 'utf8')
      const statics = [...text.matchAll(/^\s*(?:import|export)\b[^;'"]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1])
      expect(statics, file).not.toContain('@lingtai/event-store')
    }
  })
})
