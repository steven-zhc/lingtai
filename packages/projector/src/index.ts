/**
 * The fold, and the checkpoint that records how far it has got.
 *
 * Split out of `event-store` by [0022](../../../doc/decisions/0022-the-seams.md),
 * and the seam is not taxonomy. **The checkpoint advances inside the same
 * transaction as the fold's writes** — that is the whole of the correctness
 * argument — so leaving it in the store would mean handing a transaction across
 * a package boundary, which is exactly what `ProjectionContext` was doing.
 *
 * An event store offers resumption. It does not remember its readers.
 *
 * Since #219 the runner holds a `ProjectionStore` rather than a pool of its
 * own: one interface over `task_view`, `task_view_run`, `finding_backlog` and
 * `finding_backlog_run`, with `postgres.ts` beside `sqlite.ts` and
 * `test/contract.ts` — which neither owns — deciding whether they agree. The
 * SQLite one is reached at `@lingtai/projector/sqlite`, so that a barrel import
 * never loads `node:sqlite` on a Postgres install. **Nothing in this package
 * chooses between them.**
 */
export {
  createProjectionRunner,
  projectionLag,
  type ProjectionRunner,
  type ProjectionRunnerOptions,
} from "./projection.ts";
export {
  type BacklogQuery,
  type Projection,
  type ProjectionContext,
  type ProjectionLag,
  type ProjectionRow,
  type ProjectionStore,
  type TaskQuery,
} from "./store.ts";
export {
  createPostgresProjectionStore,
  type PostgresProjectionStoreOptions,
} from "./postgres.ts";
export {
  ProjectionShapeError,
  declaredColumns,
  declaredShape,
  describeDrift,
  describeShape,
  projectionShape,
  type ProjectionDrift,
  type ProjectionShape,
} from "./shape.ts";
export {
  BACKLOG_TABLE,
  backlogProjection,
  readBacklog,
  type BacklogEntry,
  type BacklogStatus,
  type ReadBacklogOptions,
} from "./backlog.ts";
export {
  DEFAULT_RETENTION_DAYS,
  TASK_VIEW_TABLE,
  describeArm,
  describeHold,
  describeWait,
  readTaskProjects,
  readTasks,
  taskViewProjection,
  type HoldLine,
  type ReadTasksOptions,
  type TaskCard,
  type TaskState,
} from "./task-view.ts";
