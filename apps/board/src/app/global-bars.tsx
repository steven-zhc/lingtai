/**
 * The bars of the pages that are not a view of a project (#1499): `Lingtai / Report`, `Lingtai / Setup / <step>`.
 * Props only and no server import, as `bar.tsx` is, so each bar is assertable in the unit half and stays out of
 * every `"use client"` graph.
 */
import type { ReactNode } from 'react'

import { Bar, BarActions } from './bar.tsx'
import { PagePlace } from './place-line.tsx'

/** A setup step's bar: `Lingtai / Setup / <step>`, with no Setup button and no project. */
export const SetupBar = ({ step }: { step?: string }) => (
  <Bar project={undefined}>
    <PagePlace crumbs={step === undefined ? ['Setup'] : ['Setup', step]} />
  </Bar>
)

/** `/report`'s bar: `Lingtai / Report`, whatever project its query names; Pause only beside a registered one. */
export const ReportBar = ({
  project,
  registered,
  pause,
}: {
  project: string | undefined
  registered: boolean
  pause?: ReactNode
}) => (
  <Bar
    project={project}
    here="report"
    actions={project !== undefined && registered ? <BarActions project={project} pause={pause} recipe={false} /> : null}
  >
    <PagePlace crumbs={['Report']} />
  </Bar>
)
