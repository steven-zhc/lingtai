# 0.16 — ACP libraries for a TypeScript client

**Status** surveyed · 2026-11-19 · what Lingtai could build its ACP runtime on,
as the client that spawns an agent and drives it. Versions and weekly downloads
are from npm on that day. Nothing here is decided; the choice belongs to the
discussion after the experiments ([0.16.md](0.16.md)).

## The candidates

| Library (npm) | Who | Side | Protocol | Latest | Weekly | License | Worth knowing |
|---|---|---|---|---|---|---|---|
| `@agentclientprotocol/sdk` | the ACP org | both | v1 stable (default import), v1 unstable, v2 draft | 2.8.0, 2026-11-18 | ~9.9M | Apache-2.0 | **2.0.0 (2026-10-19) removed `ClientSideConnection`**, which most docs still show; the API is `client({name}).onRequest(…).connectWith(stream, ctx => ctx.request(…))`. Depends on zod only. No logging hook, but the `Stream` handed to `connectWith` is a pair of web streams, so a `TransformStream` on each side sees every message |
| `effect-acp` | community, one author | both | v1, v2 opt-in | 0.1.0, 2026-10-02 (its only release) | 4.7k | MIT | **The only Effect-native one, on Effect 4** as Lingtai is (0101 §6). Its own implementation, not the official SDK's. Process ownership through Effect's `ChildProcess`, permissions resolved on the session handle, raw `AcpConnection` beneath. Unproven: one release, no stars |
| `acpx` (openclaw) | community, 3.4k stars | client: CLI and library | v1, on SDK `^1.9.0` (before 2.0) | 0.22.0, 2026-11-07 | 828k | MIT | The most-used headless client. Built-in configurations for Copilot, Antigravity and others, NDJSON event output, permission policies, cancel, queued prompts; `acpx/runtime` for use from code |
| `@tanstack/ai-acp` | TanStack | client | v1, SDK `~1.8.0` | 1.0.2, 2026-11-09 | 6.8k | MIT | ACP translated into TanStack AI's AG-UI |
| `@mcpc-tech/acp-ai-provider` | community | client | v1, SDK `^0.14.1` | 0.3.9, 2026-10-06 | 3k | MIT (repo) | An ACP agent as a Vercel AI SDK model |
| `@alint-js/model-adapter-acp` | community | client | v1, SDK `^2.4.0` | 0.8.0, 2026-11-06 | 36k | MIT | An OpenAI-compatible HTTP gateway in front of an ACP agent |
| `acp-factory`, `acp-client`, `@qlairoslabs/acp-client`, `@aaif/goose-acp-client` | community / Goose | client | v1, old SDKs | 2026-06 to 2026-11 | 26 to 5.9k | various | Stale, tiny, unlicensed, or tied to one agent |
| `use-acp`, `@jupyter-ai/acp-client` | marimo / Jupyter | client UI | v1 | — | small | — | Browser or JupyterLab; nothing headless |
| `@zed-industries/agent-client-protocol` | Zed | both | old v1 | 0.4.5, 2025-10-02 | 93k | Apache-2.0 | Deprecated: renamed to `@agentclientprotocol/sdk` |

The agent side, for what the experiments drive: Copilot and Antigravity serve
ACP themselves; `@deepseek-ai/dsh-acp` (DeepSeek's ACP server, pinned to SDK
0.25.1) is what `dsh --profile acp` runs; `@agentclientprotocol/claude-agent-acp`
and `@agentclientprotocol/codex-acp` wrap Claude Code and Codex as ACP agents
(official, 1.5M and 1.0M a week) — not needed while those two keep their own
adapters.

## What the survey changes

1. **There is no `session/set_model` any more.** SDK 0.24.0 removed the
   unstable model selector, and 2.8.0's schemas do not have it. A model is
   chosen with `session/set_config_option`, on the option whose `category` is
   `"model"` ([session config options](https://agentclientprotocol.com/protocol/session-config-options.md)).
   E6 already saw `dsh` offer one in `session/new`'s `configOptions`, and Copilot
   offer its modes and *Allow All* the same way. E9 tries both routes.
2. **Speak v1.** v2 is a draft that changes the wire format a client speaks:
   `auth/login` in place of `authenticate`, `session/prompt` answering a
   `messageId` and ending the turn with a `state_update`, `tool_call` folded into
   `tool_call_update`, no `session/set_mode`, no `fs/*` or `terminal/*`
   ([v2 migration](https://agentclientprotocol.com/protocol/v2/migration.md)).
   Every agent in the round answered `protocolVersion: 1` in E6.
3. **A terminal login method is in v1 stable:** the client runs the agent's
   program as a separate interactive process and does not pass the method to
   `authenticate`. Copilot advertises one (`copilot login`); Antigravity's four
   methods carry none; DeepSeek advertises none at all (E6).
4. **The choice to discuss:** the official SDK — widely used, current, wire
   access through its streams, but promise-based and wrapped at Lingtai's edge
   as every library's promise is (`Effect.tryPromise`) — or `effect-acp`, which
   fits Effect 4 natively and is one release old. `acpx` shows what a headless
   client needs (permission policies, cancel, NDJSON) but is a CLI on the old
   SDK, not a library to build on. The experiments' own client speaks raw
   JSON-RPC and depends on neither, so the measurements are not a vote.

## Measured (2026-11-19)

Experiment 019's E12 ran the SDK and acpx against Copilot and Antigravity: see
[019](../../experiments/019-acp-agents-measured.md#e12--through-a-library-the-official-sdk-and-acpx).
In short, the SDK behaves exactly as the raw client did and adds typing; acpx adds
exit codes for a refusal and a timeout and kills the agent's process tree, but
refuses `--model` for an agent that advertises no model option, and runs a
detached process of its own in session mode.

Sources: npm registry and download API, GitHub, the SDK's
[CHANGELOG](https://raw.githubusercontent.com/agentclientprotocol/typescript-sdk/main/CHANGELOG.md)
and [README](https://github.com/agentclientprotocol/typescript-sdk),
[effect-acp](https://github.com/julia-script/effect-acp),
[acpx](https://github.com/openclaw/acpx),
[the community list](https://agentclientprotocol.com/libraries/community).
