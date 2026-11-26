/**
 * The sandbox rows under the bar, after the lock rows (#1167): *this project is running without a sandbox*
 * (degraded, amber) and *this project is stopped: it requires a sandbox this host cannot provide* (stopped, red).
 *
 * **Not a lock.** A stopped project is a refused recipe: the way out is the install command or the recipe, so this
 * file never imports `pause-button.tsx` and has no Resume and no Lift. *Off by choice* never gets a row.
 *
 * `sandboxBanner` reads and streams; `SandboxRows` is the markup and takes its rows, so a test renders it without
 * a store.
 */
import { installFor } from '@lingtai/recipe'
import Link from 'next/link'
import { Suspense } from 'react'

import { readSandboxFacts } from '../lib/sandbox-read.ts'
import { lastSandboxRows, rememberSandboxRows, sandboxBannerRows, type SandboxBannerRow } from '../lib/sandbox-state.ts'
import { Skeleton } from './skeleton.tsx'
import { homePath, recipePath } from '@/lib/paths'

const WHAT: Record<SandboxBannerRow['kind'], { label: string; sentence: string; other: string }> = {
  stopped: {
    label: 'Sandbox stopped',
    sentence: 'this project is stopped: it requires a sandbox this host cannot provide',
    other: 'or set required: false',
  },
  degraded: {
    label: 'Sandbox degraded',
    sentence: 'this project is running without a sandbox',
    other: 'or turn it off',
  },
}

export function SandboxRows({ rows, install }: { rows: readonly SandboxBannerRow[]; install: string | undefined }) {
  if (rows.length === 0) return null
  return (
    <div className="pbanner sbanner">
      {rows.map((row) => {
        const what = WHAT[row.kind]
        return (
          <div className={`pbrow sbx-${row.kind}`} key={`sandbox:${row.project}`}>
            <b className="lab">{what.label}</b>
            <span className="what">
              <Link href={homePath(row.project)} title={`show only ${row.project}`}>
                {row.project}
              </Link>{' '}
              · {what.sentence}
              <span className="sub"> · {row.reason}</span>
            </span>
            {install === undefined ? null : <code>{install}</code>}
            <Link className="sub" href={`${recipePath(row.project)}#sandbox`}>
              {install === undefined ? what.other.replace(/^or /, '') : what.other}
            </Link>
          </div>
        )
      })}
    </div>
  )
}

async function Rows({ project }: { project: string | undefined }) {
  // A failed read draws nothing: health's own sentence and the lock row say it, never a row of ours.
  const facts = await readSandboxFacts().catch(() => null)
  if (facts === null) return null
  const rows = sandboxBannerRows(facts, project)
  rememberSandboxRows(project, rows.length)
  return <SandboxRows rows={rows} install={installFor(process.platform)?.command} />
}

/** Streams after the lock rows. `key` is for a page whose boundaries remount on a project switch (home, #1037). */
export const sandboxBanner = (project: string | undefined, key?: string) => {
  const last = lastSandboxRows(project)
  return (
    <Suspense key={key} fallback={last > 0 ? <Skeleton shape="lines" count={last} /> : null}>
      <Rows project={project} />
    </Suspense>
  )
}
