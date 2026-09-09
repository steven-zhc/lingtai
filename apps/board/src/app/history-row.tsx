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
import { shortActor, type HistoryLine } from "@/lib/history";
import { DocumentBody } from "./markdown.tsx";

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
function Document({ field, text, bytes, source }: HistoryLine["documents"][number]) {
  return (
    <details className="hdoc">
      <summary>
        <span className="hdocname">{field}</span>
        <span className="hdocsize">{bytes} bytes</span>
      </summary>
      <DocumentBody source={source} text={text} rawClass="hdoctext" />
    </details>
  );
}

export function HistoryRow({ line }: { line: HistoryLine }) {
  return (
    // Every row opens, including the ones whose summary already says
    // everything: a reader should not have to know which types the formatter
    // has learned in order to know which rows are worth clicking.
    <details>
      <summary>
        <span className="when">{line.at.slice(11, 19)}</span>
        <span className="what">{line.type}</span>
        {/* Short, with the whole of it in the title. A run's actor is 45
            characters and used to run past its own column into where the
            detail belongs (#87). */}
        <span className="who" title={line.actor}>
          {shortActor(line.actor)}
        </span>
        <span className="sum">{line.summary}</span>
      </summary>
      {/* seq first: a claim about this system's behaviour is worth more when it
          cites one. */}
      <p className="hmeta">
        seq {line.seq} · {line.streamId} v{line.version} · schema {line.schemaVer}
      </p>
      <pre className="hraw">{line.raw}</pre>
      {line.documents.map((d) => (
        <Document key={d.field} {...d} />
      ))}
    </details>
  );
}
