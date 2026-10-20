import assert from "node:assert/strict";
import test from "node:test";
import { providerAlerts } from "../src/ops-monitor.js";

test("provider alert thresholds avoid noise but catch recurring errors, rate limits, and latency", () => {
  assert.deepEqual(providerAlerts({ total: 2, errors: 1, rateLimited: 1, lowRemaining: 1, p95LatencyMs: 4_000 }), {});
  const alerts = providerAlerts({ total: 10, errors: 3, rateLimited: 2, lowRemaining: 2, p95LatencyMs: 3_100 });
  assert.deepEqual(Object.keys(alerts).sort(),
    ["provider_errors", "provider_rate_limits", "provider_latency", "provider_budget"].sort());
});
