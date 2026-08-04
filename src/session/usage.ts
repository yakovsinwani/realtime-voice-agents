import type { ProviderUsage } from '../providers/base/events.js';

/** Accumulated token consumption for a call, normalized across providers. */
export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  inputTokenDetails: { textTokens: number; audioTokens: number; cachedTokens: number };
  outputTokenDetails: { textTokens: number; audioTokens: number };
  /** Number of model responses accounted. */
  responses: number;
}

export function emptyUsage(): UsageInfo {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    inputTokenDetails: { textTokens: 0, audioTokens: 0, cachedTokens: 0 },
    outputTokenDetails: { textTokens: 0, audioTokens: 0 },
    responses: 0,
  };
}

/** Sums per-response provider usage into call totals. */
export class UsageAccumulator {
  private usage = emptyUsage();

  add(providerUsage: ProviderUsage): UsageInfo {
    this.usage.inputTokens += providerUsage.inputTokens;
    this.usage.outputTokens += providerUsage.outputTokens;
    this.usage.totalTokens += providerUsage.totalTokens;
    this.usage.inputTokenDetails.textTokens += providerUsage.inputTokenDetails?.textTokens ?? 0;
    this.usage.inputTokenDetails.audioTokens += providerUsage.inputTokenDetails?.audioTokens ?? 0;
    this.usage.inputTokenDetails.cachedTokens += providerUsage.inputTokenDetails?.cachedTokens ?? 0;
    this.usage.outputTokenDetails.textTokens += providerUsage.outputTokenDetails?.textTokens ?? 0;
    this.usage.outputTokenDetails.audioTokens += providerUsage.outputTokenDetails?.audioTokens ?? 0;
    this.usage.responses += 1;
    return this.snapshot();
  }

  snapshot(): UsageInfo {
    return structuredClone(this.usage);
  }
}
