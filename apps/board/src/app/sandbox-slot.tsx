/**
 * The sandbox icon's slot on a page's bar (#1163): the read is the page's, `Bar` stays pure.
 * Streams, so the icon loads as a bare skeleton with no label text and never holds the page.
 */
import { Suspense } from 'react'

import { readSandboxMark } from '../lib/sandbox-read.ts'
import { SandboxIcon } from './bar.tsx'

async function Icon({ project }: { project: string | undefined }) {
  const mark = await readSandboxMark(project)
  return mark === undefined ? null : <SandboxIcon mark={mark} />
}

/** `key` is for a page whose boundaries remount on a project switch (home, #1037). Hand this to `<Bar sandbox={…}>`: the selected project's state, or the worst across projects. */
export const sandboxSlot = (project: string | undefined, key?: string) => (
  <Suspense key={key} fallback={<span className="sbx sbx-skeleton" aria-hidden="true" />}>
    <Icon project={project} />
  </Suspense>
)
