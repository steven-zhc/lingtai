import type { Metadata } from 'next'
import Link from 'next/link'

import { DOCS_PUBLIC, treeOf } from '@/lib/docs'
import { readEvents } from '@/lib/events'

import { Bar, Foot } from '../../chrome'
import { DocTree } from '../doctree'
import { EventsBody } from './events-body'

export const metadata: Metadata = {
  title: 'Events',
  description: 'The ten steps of a pass and the events each writes, linked to the code that appends them.',
}

export default async function EventsPage() {
  const doc = await readEvents()
  const tree = await treeOf()
  return (
    <>
      <Bar />
      <main className="events-page">
        <div className="wrap doc-wrap">
          <section style={{ paddingTop: 32 }}>
            {/* /docs/ is a 404 while DOCS_PUBLIC is false, so the way back is a link only when it exists. */}
            <p className="kicker">{DOCS_PUBLIC ? <Link href="/docs/">Documentation</Link> : 'Documentation'}</p>
            <div className="doc-layout">
              <DocTree groups={tree} current="events" />
              <article>
                <h1>Events</h1>
                <p>
                  A pass writes events as it goes. Pick a step to see the events it writes, and an event for where it is
                  defined and where it is appended.
                </p>
                <EventsBody doc={doc} />
              </article>
            </div>
          </section>
        </div>
      </main>
      <Foot />
    </>
  )
}
