import type { Heading, StatusPart } from "@/lib/docs";

/**
 * A document's sections, beside the document.
 *
 * `reference.md` is thirty terms and 559 lines: as one scroll it is a document
 * you search rather than one you use, which is what #117 asked to fix. Every
 * word in here is the document's own heading — the only thing this file adds is
 * the word "Contents", which is navigation and not prose about the system.
 *
 * It is left out of a short document. A contents listing three sections that
 * are all on the screen already is furniture, and the page reads better without
 * it.
 */
export const ENOUGH_TO_NAVIGATE = 4;

export function Contents({ headings }: { headings: Heading[] }) {
  // `####` has an id, because links in the files point at one, but it is a
  // detail inside a section rather than a place to send somebody.
  const places = headings.filter((heading) => heading.depth <= 3);
  if (places.length < ENOUGH_TO_NAVIGATE) return null;
  return (
    <nav className="contents" aria-label="Contents">
      <p className="kicker">Contents</p>
      <ul>
        {places.map((heading) => (
          <li key={heading.id} className={heading.depth === 3 ? "sub" : undefined}>
            <a href={`#${heading.id}`}>{heading.text}</a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * What the repository says about this decision, above the decision.
 *
 * An ADR is append-only in spirit: 0014 is still here, and still says what it
 * said, and the thing a reader has to be able to see is that 0016 replaced it.
 * That fact lives in `doc/README.md`'s table and nowhere else, so it is read
 * from there and carried word for word — with the decision numbers in it made
 * links, because "superseded by 0016" without a way to reach 0016 is the least
 * useful half of the sentence.
 *
 * The date is the document's own, out of its opening lines. Between them the
 * two answer what the ticket asked of this page: what was decided, when, and
 * what replaced it.
 */
export function Status({ decided, parts }: { decided: string | null; parts: StatusPart[] }) {
  if (decided === null && parts.length === 0) return null;
  // Marked only when the *whole* decision was replaced, which is what the
  // status says when it opens with it. 0024 and 0027 read "accepted; …
  // superseded by 0026" and "accepted; supersedes 0013's claim-recovery
  // paragraph" — both are in force, and colouring them as withdrawn would be
  // the site telling a reader something the repository does not.
  const superseded = parts[0]?.text.trimStart().startsWith("superseded") ?? false;
  return (
    <p className={superseded ? "status superseded" : "status"}>
      {decided !== null && <time dateTime={decided}>{decided}</time>}
      {decided !== null && parts.length > 0 && " · "}
      {parts.map((part, index) =>
        part.href === undefined ? (
          <span key={index}>{part.text}</span>
        ) : (
          <a key={index} href={part.href}>
            {part.text}
          </a>
        ),
      )}
    </p>
  );
}
