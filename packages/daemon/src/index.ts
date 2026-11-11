export {
  DAEMON_LOCK_KEY,
  acquireDaemonLock,
  conductorLockHolder,
  createFileLocker,
  queueForDaemonLock,
  type AcquireDaemonLockOptions,
  type AcquireOptions,
  type FileLockerOptions,
  type Locker,
  type DaemonLock,
  type LockPlace,
  type LockResult,
} from './lock.ts'
export {
  startDaemon,
  notTakingWork,
  type Daemon,
  type DaemonOptions,
  type DaemonStart,
  type StopReason,
} from './daemon.ts'
export {
  COMPLETION_EVENTS,
  DISCUSSION_EVENTS,
  TRIAGE_EVENTS,
  SUBSCRIBER_TIMEOUT_MS,
  createWorkLoop,
  type EventSubscriber,
  type TurnReason,
  type WorkLoop,
  type WorkLoopOptions,
} from './work-loop.ts'
// The store this machine wrote down, and neither implementation by name: the
// Postgres one is at `@lingtai/daemon/postgres` and the SQLite one at
// `@lingtai/daemon/sqlite`, which is how a barrel import still never loads
// `node:sqlite` on a Postgres install. `choose.ts` is the one file that names
// both, and `unit/one-store.test.ts` is what keeps it the only one (#179).
export { processDaemonStore, withDaemonStore, type DaemonStoreOptions } from './choose.ts'
export { type Beat, type DaemonStore, type StoppedProjection, type StreamQuery } from './store.ts'
export {
  CONTROL_STREAM,
  HEARTBEAT_MS,
  STALE_AFTER_MS,
  beat,
  createStatusTable,
  describeInFlight,
  held,
  inFlight,
  lastBeat,
  pauseConductor,
  pauseProject,
  resumeProject,
  type ProjectPauseAnswer,
  controlWatermark,
  readControl,
  readStatus,
  recordStart,
  startAfter,
  requestsBetween,
  type RecordedStart,
  requestRun,
  requestShutdown,
  requestShutdownUnlessStanding,
  type Asking,
  resumeConductor,
  startBeacon,
  type Beacon,
  type BeaconOptions,
  type Beating,
  type BeatOptions,
  type ControlState,
  type DaemonStatus,
  type ShutdownRequest,
} from './control.ts'
export {
  codeCurrency,
  codeIdentity,
  codeRoot,
  describeCurrency,
  identityRefusals,
  readCodeVersion,
  type CodeVersion,
  type Currency,
  type CurrencyOptions,
  type Identity,
  type IdentityRefusal,
} from './currency.ts'
export {
  exists,
  findLaggingProjections,
  findOrphanLogs,
  findOrphans,
  killWorker,
  reconcile,
  releaseForeignClaims,
  type Action,
  type Finding,
  type ReconcileOptions,
} from './reconcile.ts'
export {
  clientsForProjects,
  convergeIssues,
  findIssueDrift,
  type ConvergeOptions,
  type Divergence,
} from './converge.ts'
export { lockedBy, makeGuard, type Guard, type GuardOptions } from './guard.ts'
