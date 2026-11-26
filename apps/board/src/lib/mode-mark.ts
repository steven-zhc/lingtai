/**
 * What a project's mode says in one sentence (#1463): where its work lands. A reading of `modeLines`, never a
 * second statement of the rule, and pure. The bar's slot reads the recipe the board already read (`board.askable`);
 * the menu reads each row's recorded source from the register (`modeMarks`, #1489), so every row carries its glyph.
 */
import type { ProjectState } from '@lingtai/domain'
import { parseDeclared, type Recipe } from '@lingtai/recipe'

import { modeLines } from './recipe-lines.ts'

export interface ModeMark {
  mode: 'team' | 'solo'
  sentence: string
}

export function modeMark(recipe: Recipe): ModeMark {
  const { mode, main, personal } = modeLines(recipe)
  return mode === 'team'
    ? { mode, sentence: `team · lands on ${personal ?? main}; ${main} moves when a PR merges` }
    : { mode, sentence: `solo · lands on ${main}` }
}

/** Each named project's mark, from the register's recorded source. No recipe, or one that does not parse, has none. */
export function modeMarks(projects: readonly ProjectState[]): ReadonlyMap<string, ModeMark> {
  const marks = new Map<string, ModeMark>()
  for (const p of projects) {
    if (p.project === null || p.recipe === null) continue
    const recipe = parseDeclared(p.recipe.source)
    if (recipe !== null) marks.set(p.project, modeMark(recipe))
  }
  return marks
}
