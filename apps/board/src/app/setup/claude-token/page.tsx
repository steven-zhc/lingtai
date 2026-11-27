/**
 * The token a sandboxed Claude Code run holds (#1169, 0127 §8). Whether one is
 * set is read on every render and never cached, and never says which or what.
 */
import { join } from 'node:path'

import { stateDir } from '@lingtai/env'
import { liveMachineText } from '@lingtai/setup'

import { SetupBar } from '@/app/global-bars.tsx'

import { ObjectTitle } from '../../object-title.tsx'
import { claudeTokenSetAt } from './save.ts'
import { TokenForm } from './token-form.tsx'

export const dynamic = 'force-dynamic'

export default function ClaudeToken() {
  const state = claudeTokenSetAt({ file: liveMachineText(), path: join(stateDir(), 'config.yml'), env: process.env })
  const set = 'unreadable' in state ? null : state.usable
  return (
    <main className="detail">
      <SetupBar step="Claude token" />
      <ObjectTitle tag="setup" tone="muted" title="Claude Code token" />
      <p>
        Run <code>claude setup-token</code> in a terminal and paste what it prints.
      </p>
      <p>
        {'unreadable' in state
          ? `${state.unreadable} — fix it before setting a token.`
          : set
            ? 'A token is set.'
            : 'No token is set; sandboxed Claude Code runs are refused until one is.'}
      </p>
      {'unreadable' in state ? null : <TokenForm isSet={set === true} />}
    </main>
  )
}
