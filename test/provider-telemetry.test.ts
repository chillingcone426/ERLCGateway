import assert from "node:assert/strict";
import test from "node:test";
import type { GatewayConfig } from "../src/config.js";
import { MemoryGatewayStore } from "../src/memory-store.js";
import { monitorErlcFetch } from "../src/provider-telemetry.js";

test("ER:LC telemetry keeps only request metrics and honors an exhausted bucket", async () => {
  const store = new MemoryGatewayStore();
  const reset = Math.ceil((Date.now() + 5_000) / 1000);
  const monitored = monitorErlcFetch(async () => new Response("ok", { status: 200, headers: {
    "x-ratelimit-bucket": "global", "x-ratelimit-limit": "35", "x-ratelimit-remaining": "0",
    "x-ratelimit-reset": String(reset)
  } }), store, { erlcApiBaseUrl: "https://api.erlc.gg/v2" } as GatewayConfig);
  await monitored("https://api.erlc.gg/v2/server?Players=true", { headers: { Authorization: "secret", "Server-Key": "private-key" } });
  assert.equal(store.providerRequests.length, 1);
  assert.deepEqual(Object.keys(store.providerRequests[0]!).sort(),
    ["latencyMs", "operation", "rateLimitBucket", "rateLimitLimit", "rateLimitRemaining", "recordedAt", "statusCode"].sort());
  assert.equal(store.providerRequests[0]?.operation, "players");
  assert.equal(store.providerRequests[0]?.rateLimitRemaining, 0);
  assert.ok((await store.remainingCooldown("erlc:provider:global")) > 0);
  assert.doesNotMatch(JSON.stringify(store.providerRequests), /secret|private-key|Players/);
});

test("ER:LC network failures are counted without storing credentials", async () => {
  const store = new MemoryGatewayStore();
  const monitored = monitorErlcFetch(async () => { throw new Error("offline"); }, store,
    { erlcApiBaseUrl: "https://api.erlc.gg/v2" } as GatewayConfig);
  await assert.rejects(monitored("https://api.erlc.gg/v2/server/command", { headers: { "Server-Key": "private-key" } }));
  assert.equal(store.providerRequests[0]?.operation, "command");
  assert.equal(store.providerRequests[0]?.statusCode, undefined);
  assert.doesNotMatch(JSON.stringify(store.providerRequests), /private-key/);
});
