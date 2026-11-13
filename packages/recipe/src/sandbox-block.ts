/**
 * The recipe's `sandbox:` block (#1147; plan: doc/milestone/0.14.0/0.14.md).
 *
 * **The schema holds only what the text alone decides**: the shape, a path that is `~/…` or absolute, a
 * hostname, and `enabled: false` with `required: true`. What a path collides with depends on the host's `HOME`,
 * `PNPM_HOME` and `PATH`, and a zod refinement must not read them: `sandbox.ts` checks those at resolve.
 *
 * **Optional on `Recipe` and never defaulted**, for the reason `runtime.concurrency` is: `configHash` is the hash
 * of the resolved recipe, and a default would change it for every project whose file nobody edited. Absent means
 * off. The defaults here are inside a block somebody wrote.
 */
import { z } from 'zod'

/** One DNS label: letters, digits and inner hyphens. */
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const HOSTNAME = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`, 'i')

/**
 * A hostname, or `*.` and a hostname: no scheme, port, path or other wildcard. It is held to what srt's own
 * `isValidAllowedDomainEntry` accepts, so a saved entry is never one srt rejects at registration: a plain
 * name needs a dot (or is `localhost`), and a wildcard needs two labels after it (`*.com` is too broad).
 */
export const isNetworkEntry = (entry: string): boolean => {
  const wild = entry.startsWith('*.')
  const host = wild ? entry.slice(2) : entry
  if (host.length > 253 || !HOSTNAME.test(host)) return false
  if (wild) return host.includes('.')
  return host.includes('.') || host === 'localhost'
}

/** `~`, `~/…` or absolute: a relative path names nothing, because nothing says what it is relative to. */
export const isHomeOrAbsolute = (path: string): boolean => path === '~' || path.startsWith('~/') || path.startsWith('/')

export const SandboxBlock = z
  .strictObject({
    /** Writing the block is asking for it; `enabled: false` is the explicit off. */
    enabled: z.boolean().default(true),
    /** A host that cannot provide the sandbox refuses the project, rather than running its work unsandboxed. */
    required: z.boolean().default(false),
    network: z.strictObject({ allow: z.array(z.string()).default([]) }).default({ allow: [] }),
    /** Add-only, on top of the built-ins: no key removes one. */
    write: z.array(z.string()).default([]),
    deny: z.array(z.string()).default([]),
  })
  .superRefine((block, ctx) => {
    if (!block.enabled && block.required) {
      ctx.addIssue({
        code: 'custom',
        path: ['required'],
        message:
          'required: true requires a sandbox that enabled: false turns off — ' +
          'drop one of the two, since a project cannot both need a sandbox and not have one',
      })
    }
    for (const list of ['write', 'deny'] as const) {
      block[list].forEach((path, i) => {
        if (isHomeOrAbsolute(path)) return
        ctx.addIssue({
          code: 'custom',
          path: [list, i],
          message:
            `"${path}" is a relative path, and nothing says what it is relative to — ` +
            'write it as ~/… or as an absolute path',
        })
      })
    }
    block.network.allow.forEach((entry, i) => {
      if (isNetworkEntry(entry)) return
      ctx.addIssue({
        code: 'custom',
        path: ['network', 'allow', i],
        message:
          `"${entry}" is not a domain the sandbox can allow — write a hostname or *. and a hostname, ` +
          'with no scheme, port, path or other wildcard',
      })
    })
  })

export type SandboxBlock = z.infer<typeof SandboxBlock>
