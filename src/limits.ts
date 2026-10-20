import type { UsageLimits } from "./types.js";

export const DEFAULT_LIMITS: UsageLimits = Object.freeze({
  connections: 2,
  pollSubscriptionsPerConnection: 2,
  forwardDestinationsPerConnection: 2,
  rawMirrorsPerConnection: 1,
  rulesPerConnection: 20,
  conditionsPerRule: 10,
  actionsPerRule: 1
});

export const RUNTIME_LIMITS = Object.freeze({
  ingestPerMinute: 300,
  invalidSignaturesPerTenMinutes: 20,
  destinationPerMinute: 60,
  destinationBurst: 10,
  connectionPerMinute: 120,
  accountPerMinute: 300,
  queuedPerDestination: 500,
  probationAttempts: 5,
  activeConsecutiveFailures: 10,
  maxAttemptsPerDelivery: 5,
  retryWindowMs: 15 * 60_000,
  destinationTestsPerTenMinutes: 5,
  destinationChangesPerHour: 5,
  hostedActionsPerConnectionMinute: 30,
  hostedActionsPerAccountMinute: 100,
  erlcCommandMinimumIntervalMs: 5_000,
  minimumPlayerCooldownMs: 5_000,
  maxMessageLength: 200,
  maxInboundBytes: 256 * 1024,
  maxResponseExcerptBytes: 4 * 1024
});

export class FixedWindowLimiter {
  readonly #entries = new Map<string, { count: number; resetAt: number }>();

  take(key: string, limit: number, windowMs: number, now = Date.now()) {
    const existing = this.#entries.get(key);
    const entry = !existing || existing.resetAt <= now
      ? { count: 0, resetAt: now + windowMs }
      : existing;
    if (entry.count >= limit) {
      return { allowed: false, remaining: 0, retryAfterMs: entry.resetAt - now } as const;
    }
    entry.count += 1;
    this.#entries.set(key, entry);
    return { allowed: true, remaining: limit - entry.count, retryAfterMs: 0 } as const;
  }

  clearExpired(now = Date.now()) {
    for (const [key, value] of this.#entries) {
      if (value.resetAt <= now) this.#entries.delete(key);
    }
  }
}
