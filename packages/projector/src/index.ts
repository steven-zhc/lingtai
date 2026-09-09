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
 */
export {
  createProjectionRunner,
  projectionLag,
  type Projection,
  type ProjectionContext,
  type ProjectionLag,
  type ProjectionRunner,
  type ProjectionRunnerOptions,
} from "./projection.ts";
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
  DEFAULT_RETENTION_DAYS,
  TASK_VIEW_TABLE,
  describeHold,
  readTaskProjects,
  readTasks,
  taskViewProjection,
  type HoldLine,
  type ReadTasksOptions,
  type TaskCard,
  type TaskState,
} from "./task-view.ts";
