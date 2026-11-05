/**
 * One event, as a row that opens.
 *
 * Its own module so it can be rendered by a test. `history.ts` is pure for the
 * same reason one level down — what a row *says* is testable without a database
 * — and what a row *shows* was not, which is how the page came to render the
 * prompt as a JSON string literal for as long as it did (#101).
 *
 * Under the row, in this order: where it sits on the log, the payload's
 * structure, then each document the payload carries. The structure first
 * because its marks say *below*, and the documents last because they are the
 * tall things.
 */
import { inWords } from '@lingtai/conductor/queue'

import type { PromptShown } from '@/lib/expand-prompts'
import type { HistoryLine } from '@/lib/history'

import { DocumentBody } from './markdown.tsx'
import { ShownPrompt } from './shown-prompt.tsx'

/**
 * A document, collapsed, labelled with its field and its size.
 *
 * The same trade the ticket body one section up makes: a page that opens three
 * screens tall is its own kind of unreadable, and a history of them is worse.
 *
 * **Everything here is raw**, and the two that are not the same thing are still
 * not the same: a prompt offers "read as markdown" under it, and a gate's
 * stdout does not, because markdown eats the `_`, the `#` and the `{ }` a
 * typecheck error is made of. Which of the two this is came off the payload
 * with the document (`markdown.ts`); this row does not decide and cannot.
 */
function Document({ field, text, bytes, source }: HistoryLine['documents'][number]) {
  return (
    <details className="hdoc">
      <summary>
        <span className="hdocname">{field}</span>
        <span className="hdocsize">{bytes} bytes</span>
      </summary>
      <DocumentBody source={source} text={text} rawClass="hdoctext" />
    </details>
  )
}

export function HistoryRow({ line, expanded }: { line: HistoryLine; expanded?: PromptShown | undefined }) {
  return (
    // Every row opens, including the ones whose summary already says
    // everything: a reader should not have to know which types the formatter
    // has learned in order to know which rows are worth clicking.
    <details>
      <summary>
        {/* Dated *and* relative, with the whole timestamp on the title.
            `at.slice(11, 19)` alone gives a bare `04:12:15`, so an event from
            three days ago was indistinguishable from one ten minutes old — and
            a page whose whole subject is which attempt something belongs to
            cannot leave that to be guessed (#102). */}
        <span className="when" title={line.at}>
          {line.at.slice(5, 10)} {line.at.slice(11, 19)}
          <span className="ago">{inWords(Date.now() - Date.parse(line.at))}</span>
        </span>
        {/* The sentence leads (#887). An attempt of another ticket carries the
            id it could not name in the title, never in the text. */}
        <span className="sum" title={line.summaryTitle || undefined}>
          {line.summary}
        </span>
        {/* The actor in words, with the whole of it in the title. A run's actor
            is 45 characters and used to run past its own column (#87). */}
        <span className="who" title={line.actor}>
          {line.who}
        </span>
        <span className="what">{line.type}</span>
      </summary>
      {/* seq first: a claim about this system's behaviour is worth more when it
          cites one. */}
      <p className="hmeta">
        seq {line.seq} · {line.streamId} v{line.version} · schema {line.schemaVer}
      </p>
      <pre className="hraw">{line.raw}</pre>
      {line.documents.map((d) =>
        // A `RunPrompted` that holds markers draws the prompt as it was handed
        // (#933); the payload above stays as recorded.
        expanded !== undefined && d.field === 'prompt' ? (
          <details key={d.field} className="hdoc">
            <summary>
              <span className="hdocname">{d.field}</span>
              <span className="hdocsize">{d.bytes} bytes</span>
            </summary>
            <ShownPrompt shown={expanded.shown} lines={expanded.lines} />
          </details>
        ) : (
          <Document key={d.field} {...d} />
        ),
      )}
    </details>
  )
}
