/**
 * Model pricing, in micro-USD per token.
 *
 * WHY A LOCAL TABLE: OpenRouter's response does not reliably include a cost,
 * and cost is the input to organization budgets — a feature that must not
 * silently under-report. Computing locally from published rates makes spend
 * deterministic and auditable, and keeps the numbers as exact integers.
 *
 * UNITS: prices are quoted per MILLION tokens in USD. Converting to micro-USD
 * per token is a divide by 1e6 for the "per million" and a multiply by 1e6 for
 * "USD to micro-USD" — the two cancel, so the USD-per-million figure IS the
 * micro-USD-per-token figure. Kept explicit below so nobody has to re-derive it.
 *
 * MAINTENANCE: prices change. An unknown model falls back to a deliberately
 * pessimistic default rather than zero, because under-reporting spend is far
 * worse than over-reporting it — one silently blows a budget, the other trips
 * an alert someone will investigate.
 */

export interface ModelPrice {
  /** USD per million input tokens == micro-USD per input token. */
  readonly inputPerMillion: number;
  /** USD per million output tokens == micro-USD per output token. */
  readonly outputPerMillion: number;
}

/**
 * Rates as of 2026-08. Verify against https://openrouter.ai/models before
 * relying on these for billing.
 */
export const MODEL_PRICING: Readonly<Record<string, ModelPrice>> = {
  // NVIDIA / Nemotron — OpenRouter's explicitly free route.
  'nvidia/nemotron-3-ultra-550b-a55b:free': {
    inputPerMillion: 0,
    outputPerMillion: 0,
  },

  // OpenRouter model-catalog rates retrieved 2026-08-05.
  'deepseek/deepseek-v4-flash': { inputPerMillion: 0.14, outputPerMillion: 0.28 },
  'qwen/qwen3.8-max': { inputPerMillion: 2.0, outputPerMillion: 6.0 },

  // Anthropic
  'anthropic/claude-3.5-sonnet': { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  'anthropic/claude-3.5-haiku': { inputPerMillion: 0.8, outputPerMillion: 4.0 },
  'anthropic/claude-3-opus': { inputPerMillion: 15.0, outputPerMillion: 75.0 },

  // OpenAI
  'openai/gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10.0 },
  'openai/gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.6 },

  // Nous / Hermes — named in the product spec as a primary model
  'nousresearch/hermes-3-llama-3.1-405b': { inputPerMillion: 0.8, outputPerMillion: 0.8 },
  'nousresearch/hermes-3-llama-3.1-70b': { inputPerMillion: 0.3, outputPerMillion: 0.3 },

  // Moonshot / Kimi — also named in the spec
  'moonshotai/kimi-k2': { inputPerMillion: 0.6, outputPerMillion: 2.5 },
};

/**
 * Pessimistic fallback for an unpriced model.
 *
 * Roughly Claude 3.5 Sonnet rates: high enough that an unknown model triggers
 * budget alerts early rather than quietly overspending.
 */
export const FALLBACK_PRICE: ModelPrice = { inputPerMillion: 3.0, outputPerMillion: 15.0 };

export function priceFor(model: string): ModelPrice {
  return MODEL_PRICING[model] ?? FALLBACK_PRICE;
}

/**
 * Exact cost of a call in micro-USD (millionths of a dollar).
 *
 * Returns an integer. Money is never carried as a float here: a fraction of a
 * cent per call, accumulated over millions of calls, drifts measurably.
 */
export function costMicroUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const price = priceFor(model);
  // USD-per-million == micro-USD-per-token (see units note above).
  const cost = promptTokens * price.inputPerMillion + completionTokens * price.outputPerMillion;
  return Math.ceil(cost);
}

/** True when the model has explicit pricing rather than the fallback. */
export function hasKnownPricing(model: string): boolean {
  return model in MODEL_PRICING;
}
