/** The host read (0128 §8): what `@lingtai/recipe`'s `sandbox.ts` is handed, made from `@lingtai/sandbox/host`. */
import { type SandboxHostOptions } from '@lingtai/recipe'
import { readHost } from '@lingtai/sandbox/host'

/**
 * What a caller that only *saves* a recipe hands in: the editor, `lingtai add` and onboarding. The real host
 * facts, because a path is refused at save, and no host answer, because saving is not running.
 */
export const HOST_FOR_SAVING: SandboxHostOptions = { host: 'skip', hostFacts: readHost }
