import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  backlogProjection,
  declaredShape,
  spendProjection,
  taskViewProjection,
  ticketReportProjection,
} from '../src/index.ts'

/** Captured from `declaredShape` before the projections became Effects: the DDL and its order are unchanged. */
const EXPECTED: [string, [string, string[]][]][] = [
  [
    'task_view',
    [
      [
        'task_view',
        [
          'task_id',
          'project',
          'issue',
          'title',
          'kind',
          'state',
          'tier',
          'run_id',
          'turns',
          'base_sha',
          'head_sha',
          'files',
          'insertions',
          'deletions',
          'verdicts',
          'note',
          'awaiting_sha',
          'wait_id',
          'wait_reason',
          'triage_attempt',
          'triage_started_at',
          'triage_result',
          'triage_head_sha',
          'answer',
          'split',
          'repair_pending',
          'repair_run_id',
          'updated_at',
          'closed_at',
          'attempts',
          'last_attempt_at',
          'restarts',
          'restarts_of',
          'updated_seq',
          'ticket',
        ],
      ],
      ['task_view_run', ['run_id', 'task_id', 'run']],
      ['task_view_ticket', ['task_id', 'ticket']],
    ],
  ],
  [
    'finding_backlog',
    [
      [
        'finding_backlog',
        [
          'project',
          'key',
          'issue',
          'task_id',
          'run_id',
          'step',
          'action',
          'on_sha',
          'file',
          'line',
          'severity',
          'claim',
          'failure_scenario',
          'raised_seq',
          'raised_at',
          'status',
          'decided_by',
          'decided_at',
          'decided_seq',
          'kind',
          'proposed_ref',
          'proposed_url',
          'reason',
        ],
      ],
      ['finding_backlog_run', ['run_id', 'task_id']],
    ],
  ],
  [
    'spend',
    [
      [
        'spend',
        [
          'seq',
          'at',
          'stream_id',
          'ticket',
          'project',
          'pass',
          'purpose',
          'step',
          'action',
          'round',
          'spent_for',
          'runtime',
          'turns',
          'duration_ms',
          'cost_usd',
          'usage',
          'estimated_usd',
          'estimate_fetched',
          'kind',
        ],
      ],
      ['spend_stream', ['stream_id', 'ticket', 'kind']],
      ['spend_ticket', ['ticket', 'state']],
    ],
  ],
  [
    'ticket_report',
    [
      [
        'ticket_report',
        [
          'ticket',
          'project',
          'kind',
          'outcome',
          'outcome_at',
          'passes',
          'fix_rounds',
          'machine_ms',
          'intervals_empty',
          'intervals_open',
          'unknown_claims',
          'pass_times',
          'reviews',
          'waits',
          'cost',
          'paid',
          'rounds',
          'open_intervals',
          'ticket_state',
          'by_run',
          'landing_run',
          'landing_attempt',
          'landing_fix_rounds',
          'diff_files',
          'diff_insertions',
          'diff_deletions',
          'summary',
          'summary_clipped',
        ],
      ],
      ['ticket_report_stream', ['stream_id', 'ticket']],
    ],
  ],
]

describe('declaredShape', () => {
  const projections = [taskViewProjection, backlogProjection, spendProjection, ticketReportProjection]
  for (const [name, tables] of EXPECTED) {
    it(`${name} declares the same tables and columns, in the same order`, async () => {
      const projection = projections.find((p) => p.name === name)!
      const declared = await Effect.runPromise(declaredShape(projection))
      expect([...declared]).toEqual(tables)
    })
  }
})
