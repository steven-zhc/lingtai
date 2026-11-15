/**
 * The sandbox icon's slot in the home page's rail, before health's dot (#1183): the read is the page's, `Bar` stays pure.
 * Streams, so the icon loads as a bare skeleton with no label text and never holds the page.
 */
import { Suspense } from 'react'

import { readSandboxMark } from '../lib/sandbox-read.ts'
import type { SandboxMark } from '../lib/sandbox-state.ts'
import { SandboxIcon } from './bar.tsx'

async function Icon({ project }: { project: string | undefined }) {
  // A failed read is said, never drawn as sandboxed and never a link to nowhere.
  const mark = await readSandboxMark(project).catch((): SandboxMark => ({
    state: 'unreadable',
    projects: [],
    unreadable: [],
    sentence: 'the sandbox state could not be read',
  }))
  return mark === undefined ? null : <SandboxIcon mark={mark} />
}

/** `key` is for a page whose boundaries remount on a project switch (home, #1037). Drawn in the home rail: the selected project's state, or the worst across projects. */
export const sandboxSlot = (project: string | undefined, key?: string) => (
  <Suspense key={key} fallback={<span className="sbx sbx-skeleton" aria-hidden="true" />}>
    <Icon project={project} />
  </Suspense>
)
