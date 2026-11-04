/**
 * A stopped projection as the page receives it (#840).
 *
 * The beacon's `checkpoint` is a `bigint`, and `Health` crosses to the page as
 * `JSON.stringify` in the SSE route, which throws on one — and its `catch`
 * swallows that, so the page would keep its last answer, green. Hence a string
 * here. No imports, so a unit test can reach it without a database.
 */
export interface StoppedOnTheWire {
  readonly name: string
  /** Decimal text of the seq the projection is reduced up to; null where it could not be read. */
  readonly checkpoint: string | null
  readonly error: string
}

/** `null` stays `null`: a daemon that predates the field is unknown, never empty. */
export function stoppedOnTheWire(
  list: readonly { readonly name: string; readonly checkpoint: bigint | null; readonly error: string }[] | null,
): StoppedOnTheWire[] | null {
  if (list === null) return null
  return list.map((p) => ({
    name: p.name,
    checkpoint: p.checkpoint === null ? null : p.checkpoint.toString(),
    error: p.error,
  }))
}
