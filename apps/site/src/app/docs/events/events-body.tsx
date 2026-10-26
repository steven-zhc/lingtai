import { bySection, OUTSIDE, type EventEntry } from '@/lib/events'

import type { EventsDoc } from '../../../../../../packages/domain/scripts/events.ts'

/**
 * The ten steps and the events each writes, from the manifest alone.
 *
 * Selection is HTML and CSS: a step in the drawing is a link to its section,
 * and `:target` narrows the list to it. With nothing targeted — or no
 * stylesheet, or no script — every section is on the page as a list.
 */

/** A link's label: the file and line a URL into the repository names. */
function label(url: string): string {
  const [file = url, line] = url.split('#')
  const tail = file.split('/blob/')[1]?.split('/').slice(1).join('/') ?? file
  return line === undefined ? tail : `${tail}:${line.replace(/^L/, '')}`
}

function Event({ event }: { event: EventEntry }) {
  return (
    <details className="ev">
      <summary>
        <code>{event.name}</code>
        {event.retired && <span className="ev-tag"> retired</span>}
      </summary>
      <div className="ev-body">
        <p>{event.summary ?? <em>no description in the source</em>}</p>
        <dl>
          <dt>group</dt>
          <dd>{event.group}</dd>
          <dt>stream</dt>
          <dd>
            <code>{event.stream.join(' ')}</code>
          </dd>
          <dt>schema</dt>
          <dd>
            version {event.schemaVersion}, <a href={event.definition}>{label(event.definition)}</a>
          </dd>
          <dt>appended at</dt>
          <dd>
            {event.sites.length === 0 ? (
              <em>nowhere found</em>
            ) : (
              <ul>
                {event.sites.map((site) => (
                  <li key={site}>
                    <a href={site}>{label(site)}</a>
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </dl>
        <p>Subscribe:</p>
        <pre>
          <code>{event.subscribers}</code>
        </pre>
      </div>
    </details>
  )
}

export function EventsBody({ doc }: { doc: EventsDoc }) {
  const sections = bySection(doc)
  return (
    <div className="events">
      <div className="ev-drawing" role="navigation" aria-label="The ten steps">
        <ol className="ev-spine">
          {sections
            .filter(([at]) => at !== OUTSIDE)
            .map(([at, list]) => (
              <li key={at}>
                <a href={`#at-${at}`}>
                  <span className="ev-step">{at}</span>
                  <span className="ev-count">{list.length}</span>
                </a>
              </li>
            ))}
        </ol>
        <ul className="ev-lane">
          {sections
            .filter(([at]) => at === OUTSIDE)
            .map(([at, list]) => (
              <li key={at}>
                <a href={`#at-${at}`}>
                  <span className="ev-step">{at}</span>
                  <span className="ev-count">{list.length}</span>
                </a>
              </li>
            ))}
        </ul>
      </div>
      {sections.map(([at, list]) => (
        <section key={at} id={`at-${at}`} className="ev-section">
          <h2>
            {at} <span className="ev-count">{list.length}</span>
          </h2>
          {list.length === 0 ? <p>No event is written here.</p> : list.map((e) => <Event key={e.name} event={e} />)}
        </section>
      ))}
      <p className="source">
        Rendered from <code>doc/events.json</code>; every link goes to commit <code>{doc.sha}</code>.
      </p>
    </div>
  )
}
