/**
 * The value a `StepEnded` holds for one of its actions, for `StepValue` refs
 * (#928): the action's `evidence`, or the document a `design` action drafted.
 * Reads the stored shape loosely, because a ref is made and resolved against what
 * is on the log and a malformed event is `undefined`, never a throw.
 */
export function valueOfStep(data: unknown, action: string, field: 'evidence' | 'document'): string | undefined {
  const actions = (data as { outcome?: { actions?: unknown } } | null)?.outcome?.actions
  if (!Array.isArray(actions)) return undefined
  const found = actions.find((a) => (a as { name?: unknown } | null)?.name === action) as
    | { evidence?: unknown; yields?: unknown; result?: { _tag?: unknown; design?: { document?: unknown } } }
    | undefined
  if (found === undefined) return undefined
  if (field === 'evidence') return typeof found.evidence === 'string' ? found.evidence : undefined
  const document =
    found.yields === 'design' && found.result?._tag === 'Drafted' ? found.result.design?.document : undefined
  return typeof document === 'string' ? document : undefined
}

/** The names of the actions in a `StepEnded` that hold `field`, with their values. */
export function stepValues(
  data: unknown,
  field: 'evidence' | 'document',
): readonly { readonly action: string; readonly value: string }[] {
  const actions = (data as { outcome?: { actions?: unknown } } | null)?.outcome?.actions
  if (!Array.isArray(actions)) return []
  const out: { action: string; value: string }[] = []
  for (const a of actions) {
    const name = (a as { name?: unknown } | null)?.name
    if (typeof name !== 'string') continue
    const value = valueOfStep(data, name, field)
    if (value !== undefined) out.push({ action: name, value })
  }
  return out
}
