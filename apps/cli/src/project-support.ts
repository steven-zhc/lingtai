/** Reads and change facts shared by the terminal project paths. */
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

import type { RecipeDraft } from '@lingtai/project'
import { snapshotPath, readJson } from '@lingtai/projector'
import type { ProjectAnswers, Mode } from '@lingtai/setup'

/** Whether `tool` is an existing file in a directory on this process's PATH. */
export function toolOnPath(tool: string): Promise<boolean> {
  const dirs = (process.env['PATH'] ?? '').split(delimiter).filter((d) => d !== '')
  const names = process.platform === 'win32' ? [tool, `${tool}.exe`, `${tool}.cmd`] : [tool]
  return Promise.resolve(dirs.some((dir) => names.some((name) => existsSync(join(dir, name)))))
}

/** The snapshot's rows; `null` where the file exists and is not a `{ rows: [...] }` document. */
export function fetchedRates(): readonly unknown[] | null {
  const path = snapshotPath(process.env)
  if (path === null || !existsSync(path)) return []
  const doc = readJson(path) as { rows?: unknown } | undefined
  return Array.isArray(doc?.rows) ? doc.rows : null
}

/** The mode and working branch a rerun moved, as facts. The caller turns them into the card's lines. */
export interface RecipeChanged {
  mode?: { from: Mode; to: Mode; personal?: string; main?: string }
  /**
   * `from` is the recipe's old working branch; `made` is whether the new one was made, and `madeFrom` the branch it
   * was cut from (the old one, or main where the old one is no longer on GitHub). `commits` are the ones only
   * `from` has, where the new one existed; `null` is unreadable.
   */
  branch?: { from: string; to: string; made: boolean; madeFrom?: string; commits?: string[] | null }
}

/**
 * What a GitHub rerun moved, from the recipe as the run began and what the project list answered (#1474): the mode,
 * and the personal branch. `undefined` where neither moved. The list has already read the commits only the old branch
 * has, so this reads nothing.
 */
export function changedOf(
  start: Pick<RecipeDraft, 'get' | 'text'>,
  answers: Pick<ProjectAnswers, 'mode' | 'branch' | 'make'>,
): RecipeChanged | undefined {
  if (start.text() === null) return undefined
  const name = (key: string): string | null => {
    const v = start.get(['branch', key])
    return typeof v === 'string' && v !== '' ? v : null
  }
  const changed: RecipeChanged = {}
  const modeBefore: Mode = start.get(['mode']) === 'team' ? 'team' : 'solo'
  if (answers.mode !== undefined && answers.mode !== modeBefore) {
    const personal = name('personal')
    const main = name('main')
    changed.mode = {
      from: modeBefore,
      to: answers.mode,
      ...(personal === null ? {} : { personal }),
      ...(main === null ? {} : { main }),
    }
  }
  const oldPersonal = name('personal')
  if (answers.mode === 'team' && answers.branch !== undefined && oldPersonal !== null) {
    if (oldPersonal !== answers.branch.name) {
      changed.branch = {
        from: oldPersonal,
        to: answers.branch.name,
        made: answers.make !== undefined,
        ...(answers.make === undefined ? {} : { madeFrom: answers.make.from }),
        ...(answers.make === undefined ? { commits: answers.branch.onlyIn } : {}),
      }
    }
  }
  return changed.mode === undefined && changed.branch === undefined ? undefined : changed
}
