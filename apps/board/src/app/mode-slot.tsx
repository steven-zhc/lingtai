/**
 * The mode icon's slot in the home page's rail, between the sandbox shield and health's dot (#1463). It reads
 * nothing of its own: the page hands it the board it already awaits, whose `askable` carries each recipe, so a recipe
 * is still read once per project per render. Streams, with a bare skeleton and no label text.
 */
import { Suspense } from 'react'

import type { Board } from '@/lib/board.ts'
import { selectedProject } from '@/lib/board.ts'
import { modeMark } from '@/lib/mode-mark.ts'

import { ModeLink } from './mode-glyph.tsx'

async function Icon({
  board,
  project,
}: {
  board: Promise<Pick<Board, 'askable' | 'projects'>>
  project: string | undefined
}) {
  // A failed read draws nothing, never a guessed mode.
  const read = await board.catch(() => null)
  if (read === null) return null
  const selected = selectedProject(project, read.projects)
  if (selected === undefined) return null
  const found = read.askable.find((f) => f.project === selected)
  return found === undefined ? null : <ModeLink mark={modeMark(found.recipe)} project={selected} />
}

/** `key` remounts it on a project switch, as the shield's does. */
export const modeSlot = (
  board: Promise<Pick<Board, 'askable' | 'projects'>>,
  project: string | undefined,
  key?: string,
) => (
  <Suspense key={key} fallback={<span className="mode-mark mode-skeleton" aria-hidden="true" />}>
    <Icon board={board} project={project} />
  </Suspense>
)
