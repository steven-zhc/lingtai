/**
 * `machineRuntimeRefusal` (#398): a pure function of the machine's
 * `config.yml`, so the migration message for a file still naming a runtime
 * under `runtime:` or `projects:` is tested without an `InitWorld`.
 */
import { describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'

import { machineRuntimeRefusal } from '../src/init.ts'

const PATH = '/home/me/.lingtai/config.yml'

describe('machineRuntimeRefusal', () => {
  it('refuses a file naming runtime:', () => {
    const config = parseDocument('runtime:\n  agent: codex\n')
    const refusal = machineRuntimeRefusal(config, PATH)
    expect(refusal).toContain(PATH)
    expect(refusal).toContain('runtime.agent')
  })

  it('refuses a file naming projects:', () => {
    const config = parseDocument('projects:\n  app:\n    runtime:\n      agent: codex\n')
    expect(machineRuntimeRefusal(config, PATH)).not.toBeNull()
  })

  it('is null for a file naming neither', () => {
    const config = parseDocument('database:\n  store: sqlite\n')
    expect(machineRuntimeRefusal(config, PATH)).toBeNull()
  })
})
