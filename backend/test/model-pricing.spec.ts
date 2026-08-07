import { describe, expect, it } from 'vitest';
import {
  costMicroUsd,
  hasKnownPricing,
  priceFor,
  FALLBACK_PRICE,
  MODEL_PRICING,
} from '../src/llm/openrouter/model-pricing';
import { startOfPeriod } from '../src/llm/budgets/budget.service';

describe('model pricing', () => {
  it('computes cost as an exact integer in micro-USD', () => {
    // gpt-4o: $2.50 per 1M input, $10.00 per 1M output.
    // 1000 input + 500 output = 1000*2.5 + 500*10 = 2500 + 5000 = 7500 micro-USD
    const cost = costMicroUsd('openai/gpt-4o', 1000, 500);
    expect(cost).toBe(7500);
    expect(Number.isInteger(cost)).toBe(true);
  });

  it('never returns a fractional value', () => {
    // 1 token at $0.15/1M would be 0.15 micro-USD — must round up, not truncate
    // to zero, or millions of tiny calls would accumulate to a free lunch.
    const cost = costMicroUsd('openai/gpt-4o-mini', 1, 0);
    expect(Number.isInteger(cost)).toBe(true);
    expect(cost).toBeGreaterThan(0);
  });

  it('is zero only for zero tokens', () => {
    expect(costMicroUsd('openai/gpt-4o', 0, 0)).toBe(0);
  });

  it('records zero provider cost for an explicitly free model', () => {
    const model = 'nvidia/nemotron-3-ultra-550b-a55b:free';
    expect(hasKnownPricing(model)).toBe(true);
    expect(costMicroUsd(model, 10_000, 2_000)).toBe(0);
  });

  it('uses explicit pricing for the configured paid fallbacks', () => {
    expect(priceFor('deepseek/deepseek-v4-flash')).toEqual({
      inputPerMillion: 0.14,
      outputPerMillion: 0.28,
    });
    expect(priceFor('qwen/qwen3.8-max')).toEqual({
      inputPerMillion: 2,
      outputPerMillion: 6,
    });
    expect(costMicroUsd('deepseek/deepseek-v4-flash', 1_000, 500)).toBe(280);
    expect(costMicroUsd('qwen/qwen3.8-max', 1_000, 500)).toBe(5_000);
  });

  it('prices the models named in the product spec', () => {
    // Hermes, Kimi, Claude and GPT are all named as primary models.
    expect(hasKnownPricing('anthropic/claude-3.5-sonnet')).toBe(true);
    expect(hasKnownPricing('openai/gpt-4o')).toBe(true);
    expect(hasKnownPricing('nousresearch/hermes-3-llama-3.1-405b')).toBe(true);
    expect(hasKnownPricing('moonshotai/kimi-k2')).toBe(true);
  });

  it('falls back pessimistically for an unknown model', () => {
    expect(hasKnownPricing('someone/brand-new-model')).toBe(false);
    expect(priceFor('someone/brand-new-model')).toEqual(FALLBACK_PRICE);

    // Under-reporting spend silently blows a budget; over-reporting merely
    // trips an alert someone investigates. Fallback must not be cheap.
    const unknown = costMicroUsd('someone/brand-new-model', 1000, 1000);
    const cheapest = costMicroUsd('openai/gpt-4o-mini', 1000, 1000);
    expect(unknown).toBeGreaterThan(cheapest);
  });

  it('scales linearly with token count', () => {
    const single = costMicroUsd('openai/gpt-4o', 100, 100);
    const double = costMicroUsd('openai/gpt-4o', 200, 200);
    expect(double).toBe(single * 2);
  });

  it('charges more for output than input on every priced model', () => {
    for (const [model, price] of Object.entries(MODEL_PRICING)) {
      expect(
        price.outputPerMillion,
        `${model} should not price output below input`,
      ).toBeGreaterThanOrEqual(price.inputPerMillion);
    }
  });
});

describe('budget period boundaries', () => {
  // A fixed instant: Wednesday 2026-08-12T15:30:00Z.
  const now = new Date('2026-08-12T15:30:00.000Z');

  it('starts a daily period at UTC midnight', () => {
    expect(startOfPeriod('daily', now).toISOString()).toBe('2026-08-12T00:00:00.000Z');
  });

  it('starts a weekly period on Monday', () => {
    // 2026-08-12 is a Wednesday, so the ISO week began Monday the 10th.
    expect(startOfPeriod('weekly', now).toISOString()).toBe('2026-08-10T00:00:00.000Z');
  });

  it('starts a monthly period on the first', () => {
    expect(startOfPeriod('monthly', now).toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it('handles a Sunday correctly for weekly periods', () => {
    // getUTCDay() returns 0 for Sunday, so a naive implementation would jump
    // forward to the next Monday instead of back to the previous one.
    const sunday = new Date('2026-08-16T12:00:00.000Z');
    expect(startOfPeriod('weekly', sunday).toISOString()).toBe('2026-08-10T00:00:00.000Z');
  });

  it('handles a Monday as the start of its own week', () => {
    const monday = new Date('2026-08-10T00:00:01.000Z');
    expect(startOfPeriod('weekly', monday).toISOString()).toBe('2026-08-10T00:00:00.000Z');
  });

  it('is stable across a month boundary', () => {
    const firstOfMonth = new Date('2026-09-01T00:00:00.000Z');
    expect(startOfPeriod('monthly', firstOfMonth).toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });
});
