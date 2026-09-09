/**
 * Whether a document is markdown, decided by **where it came from**.
 *
 * The rule, from [the settled design](../../../../doc/design/task-detail-page.md)
 * §6:
 *
 * | source | render |
 * |---|---|
 * | `ticket-body` — a GitHub issue body | **rendered**, sanitised, no raw HTML, remote images blocked |
 * | `prompt` — the document an agent was given | **raw**, with a rendered view one click away |
 * | `log` — gate output, `RunFailed.detail`, `RepairRequested.detail`, everything else | **never** |
 *
 * **Never sniffed.** A build log is full of things that parse as markdown and
 * are not:
 *
 * ```
 * packages/actions typecheck: test/agent-gate.test.ts(36,5): error TS2741:
 *   Property 'enforcesLimits' is missing in type '{ id: "claude-code"; … }'
 * ```
 *
 * Rendered, `_` becomes emphasis, `#` becomes a heading and the contents of
 * `{ }` are eaten. **A log rendered as markdown is not that log**, and no
 * amount of looking at the bytes tells you which of the two you have — only
 * knowing who wrote them does.
 *
 * **The prompt is raw because it is the record.** #88's whole justification is
 * that the log holds the *exact* document the agent was given, the GitHub issue
 * body having been editable afterwards; and under #104 the edit box is what
 * will run, byte for byte. Rendered, you are no longer looking at what was
 * sent. So raw is the record and "read as markdown" is the convenience, never
 * the other way round.
 *
 * **`log` is the default, and that is the safety property.** A per-field
 * allowlist of *things to render* is a list somebody must remember to leave a
 * new event type off; this is a list of the two sources that are not the log,
 * so the next event type that starts carrying a document is raw without anyone
 * doing anything. That is rule 2 of `history.ts` — the fallback is the thing
 * that cannot be wrong — pointed at rendering instead of at summaries.
 *
 * Pure, and deliberately not the renderer: `markdown.tsx` cannot render a
 * source this file has not allowed, and this file can be read by a test that
 * mounts nothing.
 */

/**
 * Who wrote a document.
 *
 * Not what it is made of, and not which field it arrived in — a source is a
 * claim about the author, which is the only thing that settles whether markdown
 * is the right reading of the bytes.
 */
export type DocumentSource = "ticket-body" | "prompt" | "log";

/** What the page is allowed to do with a source's documents. */
export type Rendering =
  /** Markdown, sanitised. */
  | "rendered"
  /** Raw, with a rendered view offered beside it. */
  | "on request"
  /** Raw, and nothing else. No renderer ever sees it. */
  | "never";

const RENDERING: Record<DocumentSource, Rendering> = {
  "ticket-body": "rendered",
  prompt: "on request",
  log: "never",
};

/** The table above, as the one function that answers it. */
export function renderingFor(source: DocumentSource): Rendering {
  return RENDERING[source];
}

/**
 * Where a document lifted out of an event payload came from.
 *
 * Two arguments and not one because a field name alone is not a source:
 * `RunPrompted.prompt` is the composed document, and `RunAwaitingInput.prompt`
 * is a sentence an agent printed. The type is half the answer.
 *
 * Everything not named here is `log`, which is *never* rendered — so being
 * behind the catalogue costs a convenience and never costs correctness.
 */
export function sourceOfPayloadDocument(type: string | undefined, field: string): DocumentSource {
  if (type === "RunPrompted" && field === "prompt") return "prompt";
  return "log";
}
