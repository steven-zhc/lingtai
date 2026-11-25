/**
 * What a project's mode says in one sentence (#1463): where its work lands. A reading of `modeLines`, never a
 * second statement of the rule, and pure — the recipe is the one the board already read (`board.askable`).
 */
import type { Recipe } from '@lingtai/recipe'

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
