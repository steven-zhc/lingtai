/**
 * **One pause ignores `since`** (`#405`). A daemon folds the control stream
 * only from its own watermark on (0102 §3, `readControl(store, since)`), so a
 * `ConductorPaused` appended before a restart is invisible to the daemon that
 * starts after it — correct for every ordinary pause, because a restart is a
 * reasonable response to most of them. It is wrong for the one pause the
 * conductor itself appends over a tier the setup cannot provide: the recipe a
 * restarted daemon loads is the same recipe, so it would refuse the same
 * ticket again, see its own un-resumed pause standing on the whole stream, and
 * log a refusal once a pass forever while `readControl` told it nothing was
 * paused.
 *
 * `holdsAcrossStarts` is the marker, and this is `readControl`'s half of the
 * fix: below the watermark, a marked pause is read through; an unmarked one —
 * a person's `lingtai pause`, or `standDownConductor`'s — is not, same as
 * before #405.
 *
 * Unit by [0060](../../../doc/decisions-archive/0060-the-gate-runs-unit-tests.md) §1:
 * a memory store, no process, no disk. The contract version —
 * `packages/daemon/test/contract.ts`'s *hides what was said before the
 * watermark from the daemon that read it* — stays integration-only, so this is
 * what checks the merge before a merge to `main`.
 */
import { CONTROL_STREAM, parsePayload } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { describe, expect, it } from 'vitest'

import { readControl, resumeConductor } from '../src/control.ts'

describe('readControl obeys a marked pause across a restart', () => {
  it('reads a pause with holdsAcrossStarts: true even from below the watermark', async () => {
    const store = createMemoryEventStore()
    await store.append(CONTROL_STREAM, 0, [
      {
        type: 'ConductorPaused',
        actor: 'conductor',
        data: parsePayload('ConductorPaused', {
          by: 'lingtai',
          reason: 'purecheck: claude-code cannot provide sandboxed: missing filesystem-sandbox.',
          until: null,
          holdsAcrossStarts: true,
        }),
      },
    ])
    // The watermark a daemon starting after this pause would read.
    const since = (await store.read(CONTROL_STREAM)).length

    const scoped = await readControl(store, since)
    expect(scoped.paused).toBe(true)
    expect(scoped.by).toBe('lingtai')
    expect(scoped.reason).toContain('sandboxed')
  })

  it('leaves a person’s unmarked pause below the watermark invisible, as before #405', async () => {
    const store = createMemoryEventStore()
    await store.append(CONTROL_STREAM, 0, [
      {
        type: 'ConductorPaused',
        actor: 'human:steven',
        data: parsePayload('ConductorPaused', {
          by: 'human:steven',
          reason: 'looking at something else',
          until: null,
          holdsAcrossStarts: false,
        }),
      },
    ])
    const since = (await store.read(CONTROL_STREAM)).length

    const scoped = await readControl(store, since)
    expect(scoped.paused).toBe(false)
  })

  it('stops being read after ConductorResumed, same as any pause', async () => {
    const store = createMemoryEventStore()
    await store.append(CONTROL_STREAM, 0, [
      {
        type: 'ConductorPaused',
        actor: 'conductor',
        data: parsePayload('ConductorPaused', {
          by: 'lingtai',
          reason: 'purecheck: claude-code cannot provide sandboxed: missing filesystem-sandbox.',
          until: null,
          holdsAcrossStarts: true,
        }),
      },
    ])
    const since = (await store.read(CONTROL_STREAM)).length
    await resumeConductor('human:steven', store)

    const scoped = await readControl(store, since)
    expect(scoped.paused).toBe(false)
  })
})
