import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `db:reset-test` truncates `events`, so its guard is the only thing between a
 * misconfigured test URL and the operator's log. Every address here is
 * `.invalid`, and each case sets all four names — an empty one is absent, and
 * setting it keeps the repository's `.env.local` from filling the gap.
 */
const SCRIPT = fileURLToPath(new URL("../scripts/reset-test-log.mjs", import.meta.url));
const POOLED = "postgresql://u:p@pooler.invalid:6543/postgres?pgbouncer=true";
const DIRECT = "postgresql://u:p@db.invalid:5432/postgres";

function reset(env: Record<string, string>) {
  return spawnSync(process.execPath, [SCRIPT], {
    env: { ...process.env, VITEST: "", LINGTAI_TEST: "1", ...env },
    encoding: "utf8",
    timeout: 20_000,
  });
}

describe("reset-test-log refuses the operator's log", () => {
  it("when the test pooled URL stands in for its direct one and is the operator's pooled URL (#176)", () => {
    const r = reset({
      LINGTAI_DATABASE_URL: POOLED,
      LINGTAI_DIRECT_DATABASE_URL: DIRECT,
      LINGTAI_TEST_DATABASE_URL: POOLED,
      LINGTAI_TEST_DIRECT_DATABASE_URL: "",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("refusing");
  });

  it("when the test direct URL is the operator's direct URL", () => {
    const r = reset({
      LINGTAI_DATABASE_URL: POOLED,
      LINGTAI_DIRECT_DATABASE_URL: DIRECT,
      LINGTAI_TEST_DATABASE_URL: "postgresql://u:p@test.invalid:5432/postgres",
      LINGTAI_TEST_DIRECT_DATABASE_URL: DIRECT,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("refusing");
  });

  it("and lets a test database of its own through to the connection", () => {
    const r = reset({
      LINGTAI_DATABASE_URL: POOLED,
      LINGTAI_DIRECT_DATABASE_URL: DIRECT,
      LINGTAI_TEST_DATABASE_URL: "postgresql://u:p@test.invalid:5432/postgres",
      LINGTAI_TEST_DIRECT_DATABASE_URL: "",
    });
    expect(r.stderr).not.toContain("refusing");
  });
});
