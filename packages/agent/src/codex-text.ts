/** A model-only Responses call. No CLI, local files, or executable tool channel. */
import type { CodexTextConfig } from '@lingtai/env'

import { NO_RUN_LOG } from './run-log.ts'
import type { RunOutcome, RunRequest, Runtime } from './runtime.ts'

type Transport = (url: string, init: RequestInit) => Promise<Response>

export interface CodexTextOptions {
  config: CodexTextConfig
  transport?: Transport
}

/** Upper bound: one token per UTF-8 byte, plus a fixed envelope allowance. */
export function codexTextSpendBound(prompt: string, config: CodexTextConfig): number {
  const inputTokens = Buffer.byteLength(prompt, 'utf8') + 4096
  return (inputTokens * config.inputUsdPerMillion + config.maxOutputTokens * config.outputUsdPerMillion) / 1_000_000
}

export function createCodexTextRuntime({ config, transport = fetch }: CodexTextOptions): Runtime {
  return {
    capabilities: {
      id: 'codex',
      hooks: [],
      canFailClosed: false,
      canRewriteToolCall: false,
      providesTier: 'sandboxed',
      enforces: ['turns', 'wall', 'usd'],
    },
    async checkAuth() {
      return { loggedIn: true, method: 'apiKey', detail: 'explicit codex_text API key configured' }
    },
    async run(request: RunRequest): Promise<RunOutcome> {
      const started = Date.now()
      const bound = codexTextSpendBound(request.prompt, config)
      const failure = (
        kind: 'crash' | 'timeout' | 'aborted' | 'out-of-usd' | 'out-of-turns',
        detail: string,
      ): RunOutcome => ({
        exitCode: null,
        turns: 0,
        durationMs: Date.now() - started,
        costUsd: null,
        text: null,
        sessionId: '',
        failure: { kind, detail },
      })
      if (request.model && request.model !== config.model)
        return failure('crash', 'model differs from codex_text.model and its configured prices')
      if (request.outputSchema) return failure('crash', 'model-only calls do not support outputSchema')
      if (request.limits.turns < 1) return failure('out-of-turns', 'one model response requires one turn')
      if (request.limits.wallMs <= 0) return failure('timeout', 'no wall time remains')
      if (bound > config.maxUsd || (request.limits.usd !== undefined && bound > request.limits.usd)) {
        return failure('out-of-usd', 'the conservative request bound exceeds the remaining USD limit')
      }
      if (request.signal?.aborted) return failure('aborted', 'cancelled before dispatch')

      const controller = new AbortController()
      const onAbort = () => controller.abort(request.signal?.reason)
      request.signal?.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => controller.abort(new Error('wall limit reached')), request.limits.wallMs)
      try {
        const response = await transport('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            model: config.model,
            input: request.prompt,
            tools: [],
            tool_choice: 'none',
            max_output_tokens: config.maxOutputTokens,
            store: false,
          }),
        })
        if (!response.ok) return failure('crash', `Responses API returned HTTP ${response.status}`)
        const result: unknown = await response.json()
        if (!result || typeof result !== 'object') return failure('crash', 'invalid Responses receipt')
        const receipt = result as Record<string, unknown>
        const usage = receipt.usage as Record<string, unknown> | undefined
        const input = usage?.input_tokens
        const produced = usage?.output_tokens
        const cached = (usage?.input_tokens_details as Record<string, unknown> | undefined)?.cached_tokens
        if (
          !Number.isSafeInteger(input) ||
          !Number.isSafeInteger(produced) ||
          (input as number) < 0 ||
          (produced as number) < 0 ||
          (cached !== undefined &&
            (!Number.isSafeInteger(cached) || (cached as number) < 0 || (cached as number) > (input as number)))
        ) {
          return failure('crash', 'Responses receipt has no usable token counts')
        }
        if (
          (input as number) > Buffer.byteLength(request.prompt, 'utf8') + 4096 ||
          (produced as number) > config.maxOutputTokens
        ) {
          return failure('crash', 'Responses receipt exceeded the preflight token bound')
        }
        const billed = {
          turns: 1,
          spendBoundUsd: bound,
          usage: [
            {
              model: config.model,
              tokens: {
                fresh: (input as number) - ((cached as number | undefined) ?? 0),
                ...(cached === undefined ? {} : { cacheRead: cached as number }),
                output: produced as number,
              },
            },
          ],
        }
        const receiptFailure = (detail: string): RunOutcome => ({ ...failure('crash', detail), ...billed })
        const output = receipt.output
        if (
          !Array.isArray(output) ||
          output.some(
            (item) =>
              !item ||
              typeof item !== 'object' ||
              (item.type !== 'message' && item.type !== 'reasoning') ||
              (item.type === 'message' && item.role !== 'assistant'),
          )
        ) {
          return receiptFailure('Responses receipt contains a tool call or invalid output')
        }
        if (receipt.status !== 'completed') return receiptFailure(`Responses status: ${String(receipt.status)}`)
        const contents = output
          .filter((item) => item.type === 'message')
          .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
        if (
          contents.some(
            (part) => !part || typeof part !== 'object' || part.type !== 'output_text' || typeof part.text !== 'string',
          )
        ) {
          return receiptFailure('Responses receipt contains non-text output')
        }
        const text = contents.map((part) => part.text as string).join('')
        ;(request.log ?? NO_RUN_LOG).note('codex', text)
        return {
          exitCode: 0,
          ...billed,
          durationMs: Date.now() - started,
          costUsd: null,
          text,
          sessionId: typeof receipt.id === 'string' ? receipt.id : '',
          failure: null,
        }
      } catch (err) {
        if (controller.signal.aborted)
          return failure(request.signal?.aborted ? 'aborted' : 'timeout', 'Responses call cancelled')
        return failure('crash', `Responses call failed: ${(err as Error).message}`)
      } finally {
        clearTimeout(timer)
        request.signal?.removeEventListener('abort', onAbort)
      }
    },
  }
}
