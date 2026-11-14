'use server'

import { join } from 'node:path'

import { stateDir } from '@lingtai/env'
import { liveMachineText } from '@lingtai/setup'

import { type ClaudeTokenAnswer, saveClaudeToken } from './save.ts'

/** Posts the token field to the one setup step; the answer says *saved* or why not, never the value. */
export async function setClaudeToken(form: FormData): Promise<ClaudeTokenAnswer> {
  return saveClaudeToken(
    { file: liveMachineText(), path: join(stateDir(), 'config.yml'), env: process.env },
    form.get('token'),
  )
}
