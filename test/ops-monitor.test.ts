import assert from "node:assert/strict";
import test from "node:test";
import { advanceAlertState, parseAlertState, providerAlerts } from "../src/ops-monitor.js";

test("provider alert thresholds avoid noise but catch recurring errors, rate limits, and latency", () => {
  assert.deepEqual(providerAlerts({ total: 2, errors: 1, rateLimited: 1, lowRemaining: 1, p95LatencyMs: 4_000 }), {});
  const alerts = providerAlerts({ total: 10, errors: 3, rateLimited: 2, lowRemaining: 2, p95LatencyMs: 3_100 });
  assert.deepEqual(Object.keys(alerts).sort(),
    ["provider_errors", "provider_rate_limits", "provider_latency", "provider_budget"].sort());
});

test("health alerts require sustained failures and sustained recovery", () => {
  let state = {};
  const check = (minutes: number, down: boolean) => {
    const result = advanceAlertState(state, down ? { gateway_health: "Gateway unreachable." } : {}, minutes * 60_000);
    state = result.state;
    return result.notifications;
  };

  assert.deepEqual(check(0, true), []);
  assert.deepEqual(check(5, false), []); // A single failed probe is ignored.
  assert.deepEqual(check(10, true), []);
  assert.deepEqual(check(15, true), []);
  assert.equal(check(20, true).length, 1);
  assert.deepEqual(check(25, true), []); // No repeated alert for one incident.
  assert.deepEqual(check(30, false), []);
  assert.deepEqual(check(35, true), []); // A single successful probe does not recover it.
  assert.deepEqual(check(40, false), []);
  assert.deepEqual(check(45, false), []);
  assert.equal(check(50, false).length, 1);
  assert.deepEqual(check(55, false), []);
});

test("elapsed time and persisted state are required for transitions", () => {
  let state = {};
  for (let time = 0; time < 3; time++) {
    const result = advanceAlertState(state, { dashboard_health: "HTTP 503" }, time * 1_000);
    assert.deepEqual(result.notifications, []);
    state = parseAlertState(JSON.parse(JSON.stringify(result.state)));
  }
  const confirmed = advanceAlertState(state, { dashboard_health: "HTTP 503" }, 10 * 60_000);
  assert.equal(confirmed.notifications.length, 1);

  const migrated = parseAlertState({ gateway_health: 12345, broken: { status: "down" } });
  assert.equal(migrated.gateway_health?.status, "down");
  assert.equal(migrated.broken, undefined);
  assert.deepEqual(advanceAlertState(migrated, { gateway_health: "unreachable" }, 20 * 60_000).notifications, []);
});
