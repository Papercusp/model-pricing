import { describe, expect, test } from 'vitest';
import {
  MODEL_PRICES,
  PRICE_TABLE_VERSION,
  PRICING_RULES_REVISION,
  costFromTokens,
  estimateCost,
  normalizeModelId,
  priceFor,
  priceTableVersion,
  type ModelPrice,
} from './index';

// WI-10004517: stored estimates are stamped with this version, and the repricer treats any
// other stamp as stale. These cases are what make "a price changed" detectable at all.
describe('priceTableVersion', () => {
  const clone = (): Record<string, ModelPrice> => JSON.parse(JSON.stringify(MODEL_PRICES));

  test('the exported constant is the live table version, 16 hex chars', () => {
    expect(PRICE_TABLE_VERSION).toBe(priceTableVersion(MODEL_PRICES));
    expect(PRICE_TABLE_VERSION).toMatch(/^[0-9a-f]{16}$/);
  });

  test('changes when any single price changes', () => {
    const table = clone();
    table['gpt-6-luna'] = { ...table['gpt-6-luna']!, in: table['gpt-6-luna']!.in + 0.01 };
    expect(priceTableVersion(table)).not.toBe(PRICE_TABLE_VERSION);
  });

  test('changes when a model is added or removed', () => {
    const added = { ...clone(), 'gpt-test-new': { in: 1, out: 2 } };
    const removed = clone();
    delete removed['gpt-6-luna'];
    expect(priceTableVersion(added)).not.toBe(PRICE_TABLE_VERSION);
    expect(priceTableVersion(removed)).not.toBe(PRICE_TABLE_VERSION);
  });

  test('changes when a long-context tier changes', () => {
    const table = clone();
    table['gpt-6-sol'] = { ...table['gpt-6-sol']!, longContext: { above: 200_000, inputMultiplier: 2, outputMultiplier: 1.5 } };
    expect(priceTableVersion(table)).not.toBe(PRICE_TABLE_VERSION);
  });

  // D-020: a stored estimate is a function of table AND rules, so a rule change must stale it.
  test('changes when the rules revision changes, with the table untouched', () => {
    expect(priceTableVersion(MODEL_PRICES, PRICING_RULES_REVISION)).toBe(PRICE_TABLE_VERSION);
    expect(priceTableVersion(MODEL_PRICES, PRICING_RULES_REVISION + 1)).not.toBe(PRICE_TABLE_VERSION);
    expect(priceTableVersion(MODEL_PRICES, PRICING_RULES_REVISION - 1)).not.toBe(PRICE_TABLE_VERSION);
  });

  test('ignores key order, so reordering the source does not re-price history', () => {
    const reversed = Object.fromEntries(
      Object.entries(clone()).reverse().map(([k, v]) => [k, Object.fromEntries(Object.entries(v).reverse())]),
    ) as Record<string, ModelPrice>;
    expect(priceTableVersion(reversed)).toBe(PRICE_TABLE_VERSION);
  });
});

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
  test.each(['constructor', '__proto__', 'toString', 'vendor/constructor:high'])('inherited property %s is unpriced', (model) => {
    expect(priceFor(model)).toBeNull();
    expect(costFromTokens(model, { inputTokens: 10 })).toMatchObject({ priced: false });
  });
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
    expect(priceFor('gpt-5.99')).toBeNull();
    expect(priceFor('claude-opus-5-99')).toBeNull();
  });
});

describe('costFromTokens', () => {
  test('uses an explicit route price without normalizing the model or falling back', () => {
    expect(costFromTokens('openrouter/openai/gpt-5.5:free', {
      inputTokens: 1_000_000, outputTokens: 1_000_000,
    }, { price: { in: 0, out: 0 } })).toEqual({ usd: 0, priced: true });
    expect(costFromTokens('gpt-5.5', { inputTokens: 10 }, { price: null }))
      .toEqual({ usd: 0, priced: false });
  });

  test('requires explicit cache rates only for cache tokens actually measured', () => {
    const price = { in: 2, out: 3 };
    expect(costFromTokens('ignored', { inputTokens: 10, cacheReadTokens: 0 }, { price }).priced).toBe(true);
    expect(costFromTokens('ignored', { cacheReadTokens: 1 }, { price }).priced).toBe(false);
    expect(costFromTokens('ignored', { cacheCreationTokens: 1 }, { price }).priced).toBe(false);
    expect(costFromTokens('ignored', { cacheReadTokens: 10, cacheCreationTokens: 10 }, {
      price: { ...price, cacheRead: 0, cacheWrite: 0 },
    })).toEqual({ usd: 0, priced: true });
  });

  test('prices explicit write TTL splits without substituting Anthropic multipliers', () => {
    const price = { in: 2, out: 3, cacheWrite: 7, cacheWrite1h: 11 };
    expect(costFromTokens('ignored', {
      cacheCreationTokens: 1_000_000, cacheCreation5mTokens: 400_000, cacheCreation1hTokens: 600_000,
    }, { price })).toEqual({ usd: 9.4, priced: true });
    expect(costFromTokens('ignored', { cacheCreationTokens: 1, cacheCreationTierUnknown: true }, {
      price, unknownTier: 'floor',
    }).priced).toBe(false);
    expect(costFromTokens('ignored', { cacheCreation5mTokens: 0, cacheCreation1hTokens: 1 }, {
      price: { in: 2, out: 3, cacheWrite: 7 },
    }).priced).toBe(false);
  });

  test('uses the full request input to select an explicit long-context price', () => {
    const price = { in: 2, out: 3, cacheRead: 0.5,
      longContext: { above: 200_000, inputMultiplier: 2, outputMultiplier: 1.5 } };
    expect(costFromTokens('ignored', { requestInputTokens: 250_000, inputTokens: 50_000,
      cacheReadTokens: 200_000, outputTokens: 100_000 }, { price }))
      .toEqual({ usd: 0.85, priced: true });
    expect(costFromTokens('ignored', { inputTokens: 50_000 }, { price }).priced).toBe(false);
  });

  test.each([-1, NaN, Infinity, 1e20])('refuses invalid explicit rate %s', (value) => {
    expect(costFromTokens('gpt-5.5', { inputTokens: 10 }, { price: { in: value, out: 1 } }).priced).toBe(false);
    expect(costFromTokens('gpt-5.5', { inputTokens: 10 }, { price: { in: 1, out: 1, cacheRead: value } }).priced).toBe(false);
  });

  test.each([-1, NaN, Infinity, 0.5, 1e20])('refuses invalid explicit token count %s', (value) => {
    expect(costFromTokens('ignored', { inputTokens: value }, { price: { in: 1, out: 1 } }).priced).toBe(false);
  });

  test('refuses arithmetic overflow instead of persisting an infinite estimate', () => {
    expect(costFromTokens('ignored', { inputTokens: Number.MAX_SAFE_INTEGER }, {
      price: { in: Number.MAX_SAFE_INTEGER, out: 1 },
    }).priced).toBe(false);
  });

  test.each([
    ['gpt-5.6-luna:medium', 1.258],
    ['openai-codex/gpt-5.6-sol:xhigh', 21.16],
    ['gpt-5.6', 21.16],
    ['gpt-5.6-terra:high', 12.58],
    ['gpt-6-astra:xhigh', 80.8],
  ])('prices %s using its own tier, including cached reads and writes', (model, expected) => {
    expect(costFromTokens(model, {
      inputTokens: 100_000, outputTokens: 1_000_000,
      cacheReadTokens: 400_000, cacheCreationTokens: 120_000,
      requestInputTokens: 620_000,
    })).toEqual({ usd: expected, priced: true });
  });
  test('a dated Luna variant uses the Luna rate instead of the family alias', () => {
    expect(estimateCost('gpt-5.6-luna-2026-09', 1_000_000, 1_000_000)).toBeCloseTo(1.4);
  });
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
  test('prices one-hour Claude writes at twice base, without charging the aggregate again', () => {
    const actual = costFromTokens('claude-opus-4-8', {
      inputTokens: 100_000,
      cacheReadTokens: 2_000_000,
      cacheCreationTokens: 1_000_000,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 1_000_000,
    });
    expect(actual).toEqual({ priced: true, usd: 11.5 });
    // Calibration: the old five-minute-only formula underprices this fixture.
    const oldEstimate = 0.5 + 1 + 6.25;
    expect(actual.usd).not.toBe(oldEstimate);
  });
  test('prices a mixed TTL response from its disjoint tier counters', () => {
    expect(costFromTokens('claude-sonnet-4-6', {
      cacheCreationTokens: 2_000_000,
      cacheCreation5mTokens: 1_500_000,
      cacheCreation1hTokens: 500_000,
    })).toEqual({ priced: true, usd: 8.625 });
    expect(costFromTokens('claude-sonnet-4-6', {
      cacheCreation5mTokens: 1_500_000,
      cacheCreation1hTokens: 500_000,
    })).toEqual({ priced: true, usd: 8.625 });
  });
  test.each([
    { inputTokens: 100, cacheCreationTokens: 0, cacheCreationUnreported: true },
    { cacheCreationTokens: 1000, cacheCreationUnreported: true },
    { cacheCreationTokens: 1000, cacheCreation1hTokens: 1000 },
    { cacheCreationTokens: 1000, cacheCreation5mTokens: 0, cacheCreation1hTokens: 999 },
    { cacheCreationTokens: 1000, cacheCreation5mTokens: -1, cacheCreation1hTokens: 1001 },
    { cacheCreationTokens: 1000, cacheCreation5mTokens: Number.NaN, cacheCreation1hTokens: 1000 },
    { cacheCreationTokens: 1000, cacheCreationTierUnknown: true },
  ])('does not fabricate a cost for missing or inconsistent reported write tiers: %j', (usage) => {
    expect(costFromTokens('claude-opus-4-8', usage)).toEqual({ priced: false, usd: 0 });
  });
  test.each([
    ['claude-sonnet-5[1m]:high', 12],
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
  test.each([
    ['gpt-6.1-sol', 2, 0.1, 2.5, 10],
    ['openai-codex/gpt-6.1-sol:max', 2, 0.1, 2.5, 10],
    ['gpt-6-sol', 2, 0.2, 2.5, 10],
    ['gpt-6-luna', 0.1, 0.01, 0.125, 0.5],
    // WI-10004502: the Scout ideator sends exactly this spec; an unpriced model
    // makes llm-client's Codex path throw before any call is made.
    ['gpt-5.4', 2.5, 0.25, 2.5, 15],
    ['gpt-5.4:medium', 2.5, 0.25, 2.5, 15],
  ] as const)('prices %s at the exact short/long boundary, counting cached tokens in context', (model, input, read, write, output) => {
    const usage = { inputTokens: 2000, cacheReadTokens: 260_000, cacheCreationTokens: 10_000, outputTokens: 1000 };
    expect(costFromTokens(model, { ...usage, requestInputTokens: 272_000 }).usd).toBeCloseTo((2000 * input + 260_000 * read + 10_000 * write + 1000 * output) / 1e6);
    expect(costFromTokens(model, { ...usage, requestInputTokens: 272_001 }).usd).toBeCloseTo(((2000 * input + 260_000 * read + 10_000 * write) * 2 + 1000 * output * 1.5) / 1e6);
    expect(costFromTokens(model, usage)).toEqual({ priced: false, usd: 0 });
  });
  test.each([['claude-opus-5-5', 0.2], ['claude-fable-5-1', 0.25]] as const)('uses the current cache-read rate for %s instead of the older prefix rate', (model, cachedUsd) => {
    expect(costFromTokens(model, { cacheReadTokens: 1_000_000 })).toEqual({ priced: true, usd: cachedUsd });
  });
  test('prices claude-sonnet-5-5 (a sibling id, not a prefix variant of claude-sonnet-5)', () => {
    expect(costFromTokens('claude-sonnet-5-5[1m]', { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheCreationTokens: 1_000_000 })).toEqual({ priced: true, usd: 2 + 10 + 0.2 + 2.5 });
  });
  test('prices gpt-5.4-mini flat (its own rates, not gpt-5.4 and no long-context tier) — WI-10004506', () => {
    const perMillion = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheCreationTokens: 1_000_000 };
    const flat = 0.75 + 4.5 + 0.075 + 0.75;
    expect(costFromTokens('gpt-5.4-mini:medium', perMillion).usd).toBeCloseTo(flat);
    // 272K is the model's max input, so a request at the gpt-5.4 long-context edge still bills flat.
    expect(costFromTokens('gpt-5.4-mini', { ...perMillion, requestInputTokens: 272_001 }).usd).toBeCloseTo(flat);
  });
});

// D-020: usage ledgers price an unknown tier at its floor and say so, instead of erasing cost.
describe("costFromTokens { unknownTier: 'floor' }", () => {
  // A live gpt-6-astra session aggregate (agent_usage_samples id 120573, 2026-09-17), stored at
  // $11.472932 before the long-context tier existed: exactly the standard-context price.
  const astraAggregate = { inputTokens: 366_710, outputTokens: 9_444, cacheReadTokens: 7_333_632 };

  test('an aggregate of a long-context model refuses by default and floors on request', () => {
    expect(costFromTokens('gpt-6-astra', astraAggregate)).toEqual({ usd: 0, priced: false });
    const floor = costFromTokens('gpt-6-astra', astraAggregate, { unknownTier: 'floor' });
    expect(floor.priced).toBe(true);
    expect(floor.bound).toBe('lower');
    expect(floor.usd).toBeCloseTo(11.472932, 9);
  });

  test('the long-context floor is the standard-tier price and never exceeds the long-tier price', () => {
    const floor = costFromTokens('gpt-6-astra', astraAggregate, { unknownTier: 'floor' });
    const standard = costFromTokens('gpt-6-astra', { ...astraAggregate, requestInputTokens: 1_000 });
    const long = costFromTokens('gpt-6-astra', { ...astraAggregate, requestInputTokens: 400_000 });
    expect(floor.usd).toBe(standard.usd);
    expect(floor.usd).toBeLessThan(long.usd);
  });

  test('a usage whose tier is known prices exactly under floor mode, with no bound', () => {
    for (const requestInputTokens of [1_000, 400_000]) {
      const usage = { ...astraAggregate, requestInputTokens };
      expect(costFromTokens('gpt-6-astra', usage, { unknownTier: 'floor' })).toEqual(costFromTokens('gpt-6-astra', usage));
    }
    const tiered = { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 300, cacheCreation5mTokens: 100, cacheCreation1hTokens: 200 };
    expect(costFromTokens('claude-opus-4-7', tiered, { unknownTier: 'floor' })).toEqual(costFromTokens('claude-opus-4-7', tiered));
  });

  test('cache writes with no TTL split floor at the 5-minute rate', () => {
    const usage = { inputTokens: 2_000, outputTokens: 1_000, cacheReadTokens: 50_000, cacheCreationTokens: 40_000 };
    const unknown = { ...usage, cacheCreationTierUnknown: true };
    expect(costFromTokens('claude-opus-4-7', unknown)).toEqual({ usd: 0, priced: false });
    const floor = costFromTokens('claude-opus-4-7', unknown, { unknownTier: 'floor' });
    const fiveMinute = costFromTokens('claude-opus-4-7', { ...usage, cacheCreation5mTokens: 40_000, cacheCreation1hTokens: 0 });
    const oneHour = costFromTokens('claude-opus-4-7', { ...usage, cacheCreation5mTokens: 0, cacheCreation1hTokens: 40_000 });
    expect(floor).toEqual({ usd: fiveMinute.usd, priced: true, bound: 'lower' });
    expect(floor.usd).toBeLessThan(oneHour.usd);
  });

  test('floor mode still refuses what has no floor', () => {
    const opts = { unknownTier: 'floor' } as const;
    expect(costFromTokens('mystery-model', astraAggregate, opts)).toEqual({ usd: 0, priced: false });
    expect(costFromTokens('claude-opus-4-7', { inputTokens: 10, cacheCreationUnreported: true }, opts))
      .toEqual({ usd: 0, priced: false });
    expect(costFromTokens('claude-opus-4-7', {
      inputTokens: 10, cacheCreationTokens: 300, cacheCreation5mTokens: 100, cacheCreation1hTokens: 100,
    }, opts)).toEqual({ usd: 0, priced: false });
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
