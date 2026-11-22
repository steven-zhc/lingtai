/** The generated rest of a PR's description, read-only: an edit to a `Closes` line would silently stop a ticket closing. */
export function GeneratedBox({ value }: { value: string }) {
  return (
    <textarea
      aria-label="The rest of the description, generated"
      className="prp-textarea generated"
      readOnly
      value={value}
      rows={Math.min(12, Math.max(3, value.split('\n').length))}
    />
  )
}
