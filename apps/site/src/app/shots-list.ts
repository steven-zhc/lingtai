/** The four pictures of the board; the caption is also each picture's `alt`. */
export const SHOTS = [
  { name: 'board', tab: 'Board', caption: 'The board — queued, running, waiting on you, landed' },
  { name: 'task', tab: 'Task', caption: 'One ticket — every step, the review, what it cost' },
  { name: 'landed', tab: 'Landed', caption: "Landed — what changed, with the AI review's summary" },
  { name: 'report', tab: 'Report', caption: 'Report — how the work converges and what it cost' },
] as const
