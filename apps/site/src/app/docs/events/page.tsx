import type { Metadata } from 'next'
import Link from 'next/link'

import { readEvents } from '@/lib/events'

import { Bar, Foot } from '../../chrome'
import { EventsBody } from './events-body'

export const metadata: Metadata = {
  title: 'Events',
  description: 'The ten steps of a pass and the events each writes, linked to the code that appends them.',
}

export default async function EventsPage() {
  const doc = await readEvents()
  return (
    <>
      <Bar />
      <main>
        <div className="wrap doc-wrap">
          <section style={{ paddingTop: 32 }}>
            <p className="kicker">
              <Link href="/docs/">Documentation</Link>
            </p>
            <h1>Events</h1>
            <p>
              A pass writes events as it goes. Pick a step to see the events it writes, and an event for where it is
              defined and where it is appended.
            </p>
            <EventsBody doc={doc} />
          </section>
        </div>
      </main>
      <Foot />
    </>
  )
}
