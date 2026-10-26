/**
 * `lingtai env` — put a value where a project can find it, and say what is there.
 *
 * `~/.lingtai/env/<project>.env` is where a project's values live
 * ([0021](../../../doc/decisions-archive/0021-the-recipe-decides-the-environment.md)),
 * and `doctor` has always named the file. Naming it left four things to get
 * right for one key and one value — the directory exists, the filename, dotenv
 * syntax, `chmod 600` — and the failure of each was the same: a project that
 * silently keeps refusing (`#62`).
 *
 * Two rules shape what is here, and both are about what a terminal remembers.
 *
 * **`list` prints names and their layer, never values**, the same rule
 * `doctor` keeps: a command that echoes a secret is a command someone runs
 * during a screen share.
 *
 * **`set` with no value reads stdin, unechoed**, which is the case worth
 * having — it keeps a connection string out of shell history, which is where
 * the last copy of a credential usually ends up.
 *
 * There is deliberately no `--from-file`. Copying an application's `.env`
 * wholesale is exactly how a `PROD_DATABASE_URL` reaches an agent; a value at a
 * time is the point, not an inconvenience to be optimised away.
 */
import { type ProjectEnvListing, projectEnvNames, setProjectEnv, unsetProjectEnv } from '@lingtai/agent-env'

import { heading, keyValues, printJson, symbol, table } from './output.ts'

const DEFERRED = 'project file — asks for a secret source (a "!" value), which is not built yet'

/**
 * Names, layers, and no values — asserted by a test, because this is the
 * function a screen share is pointed at.
 */
export function renderEnvList(
  listing: ProjectEnvListing,
  project?: string,
  options: { columns?: number | undefined } = {},
): string[] {
  if (listing.names.length === 0) return [`no names — nothing in ${listing.file}`]
  const deferred = new Set(listing.deferred)
  return [
    ...(project === undefined ? [] : [heading(`env ${project}`)]),
    ...keyValues([['file', listing.file]]),
    `${listing.names.length} name(s), values never shown`,
    '',
    ...table(
      ['NAME', 'LAYER'],
      listing.names.map((n) => [n.name, deferred.has(n.name) ? DEFERRED : n.layer]),
      options,
    ),
  ]
}

export function formatEnvList(listing: ProjectEnvListing): string {
  return renderEnvList(listing).join('\n')
}

/** `--json`: names and layers, and no field that could carry a value. */
export function envListJson(project: string, listing: ProjectEnvListing): Record<string, unknown> {
  const deferred = new Set(listing.deferred)
  return {
    project,
    file: listing.file,
    names: listing.names.map((n) => ({ name: n.name, layer: n.layer, deferred: deferred.has(n.name) })),
  }
}

/**
 * A value from stdin with nothing echoed and nothing kept.
 *
 * On a terminal the tty is put in raw mode so the characters never reach the
 * screen; off one — a pipe, a heredoc, CI — the whole of stdin is the value,
 * minus the newline the shell adds. Both are the same promise: the value is
 * never a word in a command line, so it is never in shell history.
 */
async function readValueFromStdin(name: string): Promise<string> {
  const stdin = process.stdin

  if (!stdin.isTTY) {
    stdin.setEncoding('utf8')
    let data = ''
    for await (const chunk of stdin) data += chunk as string
    return data.replace(/\r?\n$/, '')
  }

  process.stderr.write(`value for ${name} (not echoed): `)
  stdin.setRawMode(true)
  stdin.resume()
  stdin.setEncoding('utf8')

  return new Promise<string>((resolve, reject) => {
    let buffer = ''
    const done = (finish: () => void) => {
      stdin.removeListener('data', onData)
      stdin.setRawMode(false)
      stdin.pause()
      process.stderr.write('\n')
      finish()
    }
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        // Enter, or EOT: that is the value.
        if (ch === '\n' || ch === '\r' || ch === '\u0004') return done(() => resolve(buffer))
        // Ctrl-C has to stay Ctrl-C — raw mode means nobody else will deliver it.
        if (ch === '\u0003') return done(() => reject(new Error('cancelled — nothing was written')))
        if (ch === '\u007f' || ch === '\b') {
          buffer = buffer.slice(0, -1)
          continue
        }
        buffer += ch
      }
    }
    stdin.on('data', onData)
  })
}

/** `env list`: reads, renders, prints. A project the machine does not know throws, and the caller answers it. */
export async function envList(request: {
  project: string
  json: boolean
  columns?: number | undefined
}): Promise<number> {
  const listing = await projectEnvNames({ project: request.project })
  if (request.json) printJson('env list', envListJson(request.project, listing))
  else for (const line of renderEnvList(listing, request.project, { columns: request.columns })) console.log(line)
  return 0
}

/** `env set`: `KEY=VALUE` writes, a bare `KEY` reads the value from stdin. */
export async function envSet(request: { project: string; argument: string }): Promise<number> {
  const { project, argument } = request
  // The first `=` and no other: a value may hold as many as it likes, and
  // splitting on all of them is how a base64 secret loses its padding.
  const eq = argument.indexOf('=')
  const name = eq === -1 ? argument : argument.slice(0, eq)
  const value = eq === -1 ? await readValueFromStdin(name) : argument.slice(eq + 1)

  const { file, created, replaced } = await setProjectEnv({ project, name, value })
  console.log(
    `${symbol.pass()} ${name} ${replaced ? 'replaced in' : 'written to'} ${file}${created ? ' (created, 0600)' : ''}`,
  )
  return 0
}

/** `env unset`: non-zero for a name that was not there. */
export async function envUnset(request: { project: string; name: string }): Promise<number> {
  const { file, removed } = await unsetProjectEnv({ project: request.project, name: request.name })
  console.log(
    removed
      ? `${symbol.pass()} ${request.name} removed from ${file}`
      : `${symbol.fail()} ${request.name} was not set in ${file}`,
  )
  // Non-zero for a name that was not there: "I removed it" and "there was
  // nothing to remove" are different answers, and the second is the one you
  // want to hear about when you have spelled the name wrong.
  return removed ? 0 : 1
}
