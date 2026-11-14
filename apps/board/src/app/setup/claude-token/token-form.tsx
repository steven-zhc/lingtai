'use client'

import { useRef, useState } from 'react'

import { setClaudeToken } from './actions.ts'

/** A password field posting to `setClaudeToken`; the field is cleared after a post and the value is never kept in state. */
export function TokenForm({ isSet }: { isSet: boolean }) {
  const form = useRef<HTMLFormElement>(null)
  const [said, setSaid] = useState<string | null>(null)
  return (
    <form
      ref={form}
      action={async (data) => {
        const answer = await setClaudeToken(data)
        form.current?.reset()
        setSaid(answer.say)
      }}
    >
      <input type="password" name="token" autoComplete="off" aria-label="Claude Code token" required />
      <button type="submit">{isSet ? 'Replace the token' : 'Save the token'}</button>
      {said === null ? null : <p role="status">{said}</p>}
    </form>
  )
}
