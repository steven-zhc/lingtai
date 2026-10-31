import { STEPS } from '@lingtai/domain'
import Markdown from 'react-markdown'

import type { EventEntry } from '@/lib/events'

import type { EventsDoc } from '../../../../../../packages/domain/scripts/events.ts'
import { EventsFilter } from './events-filter'

/**
 * `/docs/events/` (#789): every event once, in its group, under the pass's
 * spine. Entries are rendered here, on the server, and handed to the filter as
 * nodes; the filter only hides them.
 */

/** A link's label: the file and line a URL into the repository names. */
function label(url: string): string {
  const [file = url, line] = url.split('#')
  const tail = file.split('/blob/')[1]?.split('/').slice(1).join('/') ?? file
  return line === undefined ? tail : `${tail}:${line.replace(/^L/, '')}`
}

/** Where a relative link in a summary points: the file the summary was written in, at the doc's sha. */
export function resolveSummaryHref(href: string, doc: EventsDoc): string {
  if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(href)) return href
  const sample = doc.events[0]?.definition ?? ''
  const prefix = sample.split('/blob/')[0]
  if (!prefix) return href
  try {
    return new URL(href, `${prefix}/blob/${doc.sha}/packages/domain/src/events.ts`).href
  } catch {
    return href
  }
}

/** The summary as inline markdown: code, bold, emphasis and links; anything else is text. */
export function Summary({ text, doc }: { text: string; doc: EventsDoc }) {
  return (
    <Markdown
      allowedElements={['p', 'code', 'strong', 'em', 'a']}
      unwrapDisallowed
      components={{
        p: ({ children }) => <>{children}</>,
        a: ({ href, children }) => <a href={resolveSummaryHref(href ?? '', doc)}>{children}</a>,
      }}
    >
      {text}
    </Markdown>
  )
}

function Event({ event, doc }: { event: EventEntry; doc: EventsDoc }) {
  return (
    <div className="ev" id={event.name}>
      <p className="ev-head">
        <code>{event.name}</code>
        {event.retired && <span className="ev-tag">retired</span>}
        {event.at.map((step) => (
          <span key={step} className="ev-chip">
            {step}
          </span>
        ))}
      </p>
      <p className="ev-summary">
        {event.summary === null ? <em>no description in the source</em> : <Summary text={event.summary} doc={doc} />}
      </p>
      <p className="ev-meta">
        stream <code>{event.stream.join(' ')}</code> · schema v{event.schemaVersion} · defined{' '}
        <a href={event.definition}>{label(event.definition)}</a> ·{' '}
        {event.sites.length === 0 ? (
          <em>no append site found</em>
        ) : (
          <>
            appended{' '}
            {event.sites.map((site, i) => (
              <span key={site}>
                {i > 0 && ', '}
                <a href={site}>{label(site)}</a>
              </span>
            ))}
          </>
        )}
      </p>
      <pre>
        <code>{event.subscribers}</code>
      </pre>
    </div>
  )
}

export function EventsBody({ doc }: { doc: EventsDoc }) {
  const entries = Object.fromEntries(doc.events.map((e) => [e.name, <Event key={e.name} event={e} doc={doc} />]))
  const index = doc.events.map(({ name, group, at }) => ({ name, group, at }))
  return (
    <EventsFilter steps={[...STEPS]} index={index} entries={entries}>
      <h1>Events</h1>
      <p>
        A pass writes events as it goes. Pick a step to see the events it writes; every event is listed once, under its
        group.
      </p>
      <p className="source">
        Rendered from <code>doc/events.json</code>; every link goes to commit <code>{doc.sha}</code>.
      </p>
    </EventsFilter>
  )
}
