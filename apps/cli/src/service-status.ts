/**
 * What `lingtai service status` reports (#622), as a value: the read makes it,
 * `renderServiceStatus` draws it and `serviceStatusJson` is its document — the
 * three parts `status.ts` has. Pure, so the layout and the shape are tested with
 * no supervisor and no board.
 *
 * Two jobs, two sections, never one summary: a board that is up beside a
 * conductor launchd respawns every thirty seconds is the state one word for both
 * would hide. And the supervisor's own lines are printed as it said them — a job
 * being *loaded* is not a daemon taking work.
 */
import { keyValues, section } from './output.ts'

/** The supervisor's answer, or why it could not be asked; never folded into "not loaded". */
export type SupervisorAnswer = { lines: readonly string[] } | { unread: string }

export interface JobStatus {
  /** `gui/501/<label>` under launchd, the unit name under systemd. */
  target: string
  supervisor: SupervisorAnswer
}

export interface ServiceStatus {
  platform: 'launchd' | 'systemd'
  conductor: JobStatus & { beacon: string | { unread: string } }
  board: JobStatus & {
    url: string
    /** A URL, `null` where nothing answers, or why it could not be asked. */
    answers: string | null | { unread: string }
    missing: { why: string; remedy: readonly string[] } | null
  }
}

/** The exit code `service status` has always had: non-zero when a supervisor could not be read. */
export function serviceStatusCode(s: ServiceStatus): number {
  if ('unread' in s.conductor.supervisor) return 1
  return 'unread' in s.board.supervisor ? 1 : 0
}

function supervisorLines(a: SupervisorAnswer): string[] {
  const lines = 'unread' in a ? [`could not ask — ${a.unread}`] : [...a.lines]
  return lines.length > 0 ? lines : ['loaded, and said nothing about the process']
}

function supervisorBlock(s: ServiceStatus, job: JobStatus): string[] {
  const via = s.platform === 'launchd' ? 'launchctl' : 'systemctl --user'
  const [first = '', ...rest] = supervisorLines(job.supervisor)
  return [...keyValues([['supervisor', first]]), ...rest.map((l) => `  ${l}`), `  (${via}, ${job.target})`]
}

export function renderServiceStatus(s: ServiceStatus): string[] {
  const beacon =
    typeof s.conductor.beacon === 'string' ? s.conductor.beacon : `could not read it — ${s.conductor.beacon.unread}`
  const answers = s.board.answers
  const boardWord =
    typeof answers === 'string'
      ? `answers on ${answers}`
      : answers === null
        ? 'nothing answers'
        : `could not ask — ${answers.unread}`
  const missing = s.board.missing
  return [
    ...section('the conductor', [
      ...supervisorBlock(s, s.conductor),
      ...keyValues([['daemon', beacon]]),
      '  (daemon_status, the beacon — whether it is beating, which loaded does not say)',
    ]).split('\n'),
    '',
    ...section('the board', [
      ...supervisorBlock(s, s.board),
      ...keyValues([['board', boardWord]]),
      `  (${s.board.url} — whether a board answers there, which loaded does not say)`,
      ...(missing === null ? [] : [`${missing.why}, so this machine has no board job to keep`, ...missing.remedy]),
    ]).split('\n'),
  ]
}

export function serviceStatusJson(s: ServiceStatus): Record<string, unknown> {
  return {
    platform: s.platform,
    conductor: { target: s.conductor.target, supervisor: s.conductor.supervisor, beacon: s.conductor.beacon },
    board: {
      target: s.board.target,
      supervisor: s.board.supervisor,
      url: s.board.url,
      answers: s.board.answers,
      ...(s.board.missing === null ? {} : { missing: { why: s.board.missing.why, remedy: s.board.missing.remedy } }),
    },
  }
}
