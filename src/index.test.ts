import { describe, expect, test } from 'vitest';
import {
  MODEL_PRICES,
  costFromTokens,
  estimateCost,
  normalizeModelId,
  priceFor,
} from './index';

describe('normalizeModelId', () => {
  test('strips vendor prefix', () => {
    expect(normalizeModelId('openai-codex/gpt-5.5')).toBe('gpt-5.5');
  });
  test('strips effort suffix', () => {
    expect(normalizeModelId('openai-codex/gpt-5.5:xhigh')).toBe('gpt-5.5');
  });
  test('lowercases + trims', () => {
    expect(normalizeModelId(' Claude-Opus-4-8 ')).toBe('claude-opus-4-8');
  });
});

describe('priceFor', () => {
  test('exact bare id', () => {
    expect(priceFor('claude-opus-4-8')).toEqual({ in: 5.0, out: 25.0 });
  });
  test('vendor-prefixed id resolves to bare entry', () => {
    expect(priceFor('openai-codex/gpt-5.5')).toEqual(MODEL_PRICES['gpt-5.5']);
    expect(priceFor('openai-codex/gpt-5.5:xhigh')).toEqual(MODEL_PRICES['gpt-5.5']);
  });
  test('dated variant prefix-matches family entry', () => {
    expect(priceFor('claude-opus-4-5-20251101')).toEqual(MODEL_PRICES['claude-opus-4-5']);
    expect(priceFor('claude-haiku-4-5-20251001')).toEqual(MODEL_PRICES['claude-haiku-4-5']);
  });
  test('longest prefix wins (gpt-5.5 not gpt-5)', () => {
    // 'gpt-5.5-2026-01' must match gpt-5.5, not the shorter gpt-5
    expect(priceFor('gpt-5.5-2026-01')).toEqual(MODEL_PRICES['gpt-5.5']);
  });
  test('current Claude 5 model specs resolve through context and effort suffixes', () => {
    expect(priceFor('claude-sonnet-5[1m]:high')).toEqual(MODEL_PRICES['claude-sonnet-5']);
    expect(priceFor('claude-fable-5[1m]:xhigh')).toEqual(MODEL_PRICES['claude-fable-5']);
  });
  test('unknown model → null (omp local models, empty string)', () => {
    expect(priceFor('qwen2.5-coder:14b')).toBeNull();
    expect(priceFor('')).toBeNull();
  });
});

describe('costFromTokens', () => {
  test('claude: input+output+cache defaults', () => {
    const { usd, priced } = costFromTokens('claude-opus-4-8', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 1_000_000,
    });
    expect(priced).toBe(true);
    // 5 + 25 + 0.5 (0.1×in) + 6.25 (1.25×in)
    expect(usd).toBeCloseTo(36.75, 6);
  });
  test('codex: explicit cacheRead price', () => {
    const { usd, priced } = costFromTokens('openai-codex/gpt-5', {
      inputTokens: 800_000,
      cacheReadTokens: 200_000,
      outputTokens: 100_000,
    });
    expect(priced).toBe(true);
    // 0.8×1.25 + 0.2×0.125 + 0.1×10 = 1 + 0.025 + 1
    expect(usd).toBeCloseTo(2.025, 6);
  });
  test.each([
    ['claude-sonnet-5[1m]:high', 18],
    ['claude-fable-5[1m]:xhigh', 60],
  ])('current Claude 5 model %s is priced instead of persisted as NULL', (model, expectedUsd) => {
    expect(
      costFromTokens(model, { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    ).toEqual({ usd: expectedUsd, priced: true });
  });
  test('unknown model → priced:false, usd 0 (caller persists NULL, not 0)', () => {
    expect(costFromTokens('qwen2.5-coder:14b', { inputTokens: 5000 })).toEqual({
      usd: 0,
      priced: false,
    });
  });
  test('negative / NaN token counts are ignored', () => {
    const { usd } = costFromTokens('claude-haiku-4-5', {
      inputTokens: -5,
      outputTokens: Number.NaN,
    });
    expect(usd).toBe(0);
  });
});

describe('estimateCost (testing-shell back-compat shape)', () => {
  test('matches the original input+output formula', () => {
    expect(estimateCost('claude-sonnet-4-6', 1_000_000, 1_000_000)).toBeCloseTo(18.0, 6);
  });
  test('unknown model → 0 (original behavior)', () => {
    expect(estimateCost('mystery-model', 1000, 1000)).toBe(0);
  });
});
