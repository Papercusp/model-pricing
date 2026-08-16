/**
 * @papercusp/model-pricing — canonical model→price table + cost estimation.
 *
 * Single source of truth for agent-model list prices (cross-backend-cost-capture
 * P-003 / D-005). Consumers: the orchestrator (`sumJsonlCost` cost cap,
 * `usage-sample-pg` estimated cost), operator-core (`agent-usage-telemetry`,
 * harness insights), and `@papercusp/testing-shell/llm` (re-export, keeps its
 * public `MODEL_PRICES`/`estimateCost` API).
 *
 * Semantics:
 *   - Prices are USD per 1M tokens (provider LIST prices — an *estimate*, not
 *     billed spend; subscription plans bill differently). Anything computed
 *     from this table must be labeled estimated (`cost_source = 'estimated'`).
 *   - `inputTokens` means UNCACHED input tokens (Anthropic's `usage.input_tokens`
 *     semantics — cache reads/writes are separate fields). Extractors for
 *     OpenAI-style usage (where `input_tokens` includes `cached_input_tokens`)
 *     must subtract the cached subset before calling `costFromTokens`.
 *   - Cache-read defaults to 0.1× input (Anthropic documented multiplier; the
 *     gpt-5 family's cached-input price is also 0.1×). Cache-creation defaults
 *     to 1.25× input (Anthropic 5-minute-TTL write premium; OpenAI has no write
 *     premium and reports no cache-creation count, so the default never fires
 *     there).
 *   - Unknown model → `priced: false`, usd 0. Never $0-guess a real model:
 *     callers persist NULL cost rather than a fabricated zero.
 *
 * Maintenance reality (accepted in D-002-A): prices drift as providers ship
 * models. Update THIS table only — every consumer follows. Prices verified
 * 2026-06-05 (Anthropic: opus 4.x $5/$25, sonnet 4.6 $3/$15, haiku 4.5 $1/$5;
 * cache read 0.1×, 5-min cache write 1.25×).
 */

export interface ModelPrice {
  /** USD per 1M uncached input tokens. */
  in: number;
  /** USD per 1M output tokens. */
  out: number;
  /** USD per 1M cache-read tokens. Default: `in × 0.1`. */
  cacheRead?: number;
  /** USD per 1M cache-creation tokens. Default: `in × 1.25`. */
  cacheWrite?: number;
}

/**
 * Keys are BARE model ids (no vendor prefix). `priceFor` normalizes inputs
 * like `openai-codex/gpt-5.5:xhigh` → `gpt-5.5` before lookup, and falls back
 * to a longest-prefix match so dated variants (`claude-opus-4-5-20251101`)
 * resolve to their family entry.
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  // ── Anthropic (per-MTok list price; opus 4.5+ is $5/$25) ──
  // Opus 5 is a fixed id with NO date suffix, and lands at the same $5/$25 as the
  // 4.5+ Opus tier (verified 2026-08-11 against the claude-api model catalog:
  // 1M context, 128K max output, effort low→max, thinking on by default).
  'claude-opus-5': { in: 5.0, out: 25.0 },
  'claude-opus-4-8': { in: 5.0, out: 25.0 },
  'claude-opus-4-7': { in: 5.0, out: 25.0 },
  'claude-opus-4-6': { in: 5.0, out: 25.0 },
  'claude-opus-4-5': { in: 5.0, out: 25.0 },
  // Legacy opus (4.1 and earlier) kept the old price point.
  'claude-opus-4-1': { in: 15.0, out: 75.0 },
  'claude-opus-4-0': { in: 15.0, out: 75.0 },
  'claude-sonnet-4-6': { in: 3.0, out: 15.0 },
  'claude-sonnet-4-5': { in: 3.0, out: 15.0 },
  'claude-sonnet-4-0': { in: 3.0, out: 15.0 },
  'claude-haiku-4-5': { in: 1.0, out: 5.0 },

  // ── OpenAI (codex CLI models; cached input is 0.1× for the gpt-5 family,
  //    no cache-write premium) ──
  'gpt-5': { in: 1.25, out: 10.0, cacheRead: 0.125, cacheWrite: 1.25 },
  'gpt-5.6': { in: 1.875, out: 15.0, cacheRead: 0.1875, cacheWrite: 1.875 },
  'gpt-5.5': { in: 2.5, out: 20.0, cacheRead: 0.25, cacheWrite: 2.5 },
  // OpenAI-direct models used by LLM-testing hosts (e.g. Restart's Scout SUT).
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-4o': { in: 2.5, out: 10.0 },
};

/**
 * Normalize a model id for lookup: lowercase, strip a vendor prefix
 * (`openai-codex/gpt-5` → `gpt-5`) and an effort/variant suffix
 * (`gpt-5.5:xhigh` → `gpt-5.5`).
 */
export function normalizeModelId(model: string): string {
  let m = model.trim().toLowerCase();
  const slash = m.lastIndexOf('/');
  if (slash >= 0) m = m.slice(slash + 1);
  const colon = m.indexOf(':');
  if (colon >= 0) m = m.slice(0, colon);
  return m;
}

/** Resolve a price entry. Exact (raw, then normalized), then longest-prefix match. Null when unknown. */
export function priceFor(model: string): ModelPrice | null {
  if (!model) return null;
  if (MODEL_PRICES[model]) return MODEL_PRICES[model];
  const norm = normalizeModelId(model);
  if (MODEL_PRICES[norm]) return MODEL_PRICES[norm];
  let best: string | null = null;
  for (const key of Object.keys(MODEL_PRICES)) {
    if (norm.startsWith(key) && (best === null || key.length > best.length)) {
      best = key;
    }
  }
  return best ? MODEL_PRICES[best] : null;
}

export interface TokenUsage {
  /** UNCACHED input tokens (see header — subtract cached subsets first). */
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface CostEstimate {
  /** Estimated USD at list price. 0 when `priced` is false. */
  usd: number;
  /** False when the model isn't in the table — persist NULL, not 0. */
  priced: boolean;
}

/** Estimate cost from token counts at list price. Provider-reported cost always wins over this. */
export function costFromTokens(model: string, usage: TokenUsage): CostEstimate {
  const p = priceFor(model);
  if (!p) return { usd: 0, priced: false };
  const n = (v: number | undefined): number =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
  const cacheRead = p.cacheRead ?? p.in * 0.1;
  const cacheWrite = p.cacheWrite ?? p.in * 1.25;
  const usd =
    (n(usage.inputTokens) * p.in +
      n(usage.outputTokens) * p.out +
      n(usage.cacheReadTokens) * cacheRead +
      n(usage.cacheCreationTokens) * cacheWrite) /
    1_000_000;
  return { usd, priced: true };
}

/**
 * Back-compat shape for `@papercusp/testing-shell/llm`'s original API:
 * input+output only, unknown models price at 0.
 */
export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  return costFromTokens(model, { inputTokens, outputTokens }).usd;
}
