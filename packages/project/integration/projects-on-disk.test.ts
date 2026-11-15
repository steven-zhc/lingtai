/** `projectsOnDisk` (#1178) lists a real directory — the filesystem, so this is the integration half (0060 §1). */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { projectsOnDisk } from '../src/index.ts'

describe('projectsOnDisk', () => {
  it('lists the directories of a home that hold a recipe file', () => {
    const home = mkdtempSync(join(tmpdir(), 'projects-on-disk-'))
    mkdirSync(join(home, 'has'))
    writeFileSync(join(home, 'has', 'recipe.yml'), 'version: 2\n')
    mkdirSync(join(home, 'empty'))
    writeFileSync(join(home, 'config.yml'), '')
    expect(projectsOnDisk(home)).toEqual(['has'])
  })
})
