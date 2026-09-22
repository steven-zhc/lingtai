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
} from "./lock.ts";
export {
  startDaemon,
  type Daemon,
  type DaemonOptions,
  type DaemonStart,
  type StopReason,
} from "./daemon.ts";
export {
  COMPLETION_EVENTS,
  SUBSCRIBER_TIMEOUT_MS,
  createWorkLoop,
  type EventSubscriber,
  type PassReason,
  type WorkLoop,
  type WorkLoopOptions,
} from "./work-loop.ts";
// The store this machine wrote down, and neither implementation by name: the
// Postgres one is at `@lingtai/daemon/postgres` and the SQLite one at
// `@lingtai/daemon/sqlite`, which is how a barrel import still never loads
// `node:sqlite` on a Postgres install. `choose.ts` is the one file that names
// both, and `pure/one-store.test.ts` is what keeps it the only one (#179).
export {
  processDaemonStore,
  withDaemonStore,
  type DaemonStoreOptions,
} from "./choose.ts";
export {
  type Beat,
  type DaemonStore,
  type StreamQuery,
} from "./store.ts";
export {
  CONTROL_STREAM,
  HEARTBEAT_MS,
  STALE_AFTER_MS,
  beat,
  createStatusTable,
  describeInFlight,
  inFlight,
  lastBeat,
  pauseConductor,
  controlWatermark,
  readControl,
  readStatus,
  recordStart,
  startAfter,
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
  withdrawShutdown,
  type BeatOptions,
  type ControlState,
  type DaemonStatus,
  type Withdrawal,
  type ShutdownRequest,
} from "./control.ts";
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
} from "./currency.ts";
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
} from "./reconcile.ts";
export {
  clientsForProjects,
  convergeIssues,
  findIssueDrift,
  type ConvergeOptions,
  type Divergence,
} from "./converge.ts";
