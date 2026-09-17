/**
 * Whether a runtime is signed in, asked of the runtime itself.
 *
 * Its own file, importing nothing but `node:child_process`, because
 * `lingtai init` asks before there is a log (#186): the package's barrel loads
 * `hook-socket.ts`, which loads `@lingtai/event-store`, whose client is built at
 * module scope and throws without a database URL. So a machine that has only
 * just installed could not ask which agent it has without first saying which
 * database it wants — the order the ticket forbids.
 */
import { spawn } from "node:child_process";
import type { AuthStatus } from "./runtime.ts";

/**
 * `claude auth status`, in the environment a run would actually get.
 *
 * Free — it reads the credential and does not call the API. Verified
 * against both environments: without `USER` it answers
 * `{loggedIn: false, authMethod: "none"}`, with it
 * `{loggedIn: true, authMethod: "claude.ai"}`.
 *
 * **The exit code is 0 either way**, so the field is the answer and the
 * code is not. Reading the code would have made this check pass in exactly
 * the situation it exists to catch.
 */
export function claudeCodeAuth(binary: string, env: Record<string, string>): Promise<AuthStatus> {
  return new Promise<AuthStatus>((resolve) => {
    const child = spawn(binary, ["auth", "status"], {
      // Cast for a compiler that widens `ProcessEnv` — Next's does, and the
      // board reaches this through `currentRecipe`'s sign-in detection.
      env: env as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (err += c.toString()));

    // A hung probe must not hang the doctor.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ loggedIn: false, method: null, detail: "claude auth status did not answer in 20s" });
    }, 20_000);

    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ loggedIn: false, method: null, detail: e.message });
    });

    child.on("close", () => {
      clearTimeout(timer);
      // Defensive for the same reason `parseResult` is: a wrapper or a
      // warning can put a line in front of the JSON.
      const brace = out.indexOf("{");
      if (brace < 0) {
        resolve({
          loggedIn: false,
          method: null,
          detail: (err.trim() || out.trim() || "no output").slice(0, 300),
        });
        return;
      }
      try {
        const parsed = JSON.parse(out.slice(brace)) as {
          loggedIn?: boolean;
          authMethod?: string;
        };
        resolve({
          loggedIn: parsed.loggedIn === true,
          method: parsed.authMethod ?? null,
          detail: parsed.loggedIn === true ? `signed in via ${parsed.authMethod}` : "not signed in",
        });
      } catch {
        resolve({ loggedIn: false, method: null, detail: out.slice(0, 300) });
      }
    });
  });
}

/**
 * `codex login status`, in the environment a run would get.
 *
 * Real, though the adapter is not: which runtimes are signed in decides
 * whether `runtime.agent` may be detected at all (0046 §3), and a machine
 * signed in to both must be asked rather than handed the one that happened
 * to have a probe. The exit code is the answer — 0 `Logged in using …`,
 * 1 `Not logged in` — and a missing binary is not signed in.
 */
export function codexAuth(binary: string, env: Record<string, string>): Promise<AuthStatus> {
  return new Promise<AuthStatus>((resolve) => {
    const child = spawn(binary, ["login", "status"], {
      env: env as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (out += c.toString()));

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ loggedIn: false, method: null, detail: "codex login status did not answer in 20s" });
    }, 20_000);

    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ loggedIn: false, method: null, detail: e.message });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const detail = (out.trim() || "no output").slice(0, 300);
      resolve({ loggedIn: code === 0, method: null, detail });
    });
  });
}
