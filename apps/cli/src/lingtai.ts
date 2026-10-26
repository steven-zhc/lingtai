#!/usr/bin/env node
/**
 * `lingtai` — the file a supervisor's unit names.
 *
 * The launchd plist and the systemd `ExecStart` that `lingtai service` writes run
 * `node <root>/apps/cli/src/lingtai.ts <job argv>`, and `keeper` refuses a plist that
 * does not name this file (`service.ts`). Renaming it would orphan every unit already
 * on disk, and launchd would respawn each one every thirty seconds (#187). So it stays,
 * and it holds nothing: `entry.ts` reads the same argv and is the only door to the parser.
 */
import './entry.ts'
