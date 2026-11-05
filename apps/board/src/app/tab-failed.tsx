/**
 * A tab whose read failed says what failed and nothing else; the top of the
 * page, which is the layout's, is unaffected (#885). Never the error's own text:
 * it may carry a URL or a token.
 */
export function TabFailed({ what }: { what: string }) {
  return (
    <p className="empty refusal">Reading {what} failed. The rest of this page is unaffected — reload to try again.</p>
  )
}
