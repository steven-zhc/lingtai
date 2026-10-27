/**
 * The relevant entries of LiteLLM's `model_prices_and_context_window.json`,
 * copied for #658 so no test fetches. `gpt-6-astra` is listed under three keys
 * at three prices: only the `openai` one is the runtime's own.
 */
export const LITELLM_FIXTURE = {
  'gpt-6-astra': {
    litellm_provider: 'openai',
    input_cost_per_token: 0.00001,
    output_cost_per_token: 0.00005,
    cache_read_input_token_cost: 0.000001,
    cache_creation_input_token_cost: 0.0000125,
  },
  'azure/us/gpt-6-astra': {
    litellm_provider: 'azure',
    input_cost_per_token: 0.000011,
    output_cost_per_token: 0.000055,
    cache_read_input_token_cost: 0.0000011,
    cache_creation_input_token_cost: 0.00001375,
  },
  'chatgpt/gpt-6-astra': {
    litellm_provider: 'chatgpt',
    input_cost_per_token: null,
    output_cost_per_token: null,
  },
  'gpt-6-nocache': {
    litellm_provider: 'openai',
    input_cost_per_token: 0.000002,
    output_cost_per_token: 0.00001,
  },
  'gpt-6-wild': {
    litellm_provider: 'openai',
    input_cost_per_token: 0.5,
    output_cost_per_token: 0.00001,
  },
  'claude-sonnet-5': {
    litellm_provider: 'anthropic',
    input_cost_per_token: 0.000099,
    output_cost_per_token: 0.000099,
  },
} as const
