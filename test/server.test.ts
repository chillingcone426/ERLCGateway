import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import type { GatewayConfig } from "../src/config.js";
import { MemoryGatewayStore } from "../src/memory-store.js";
import { encryptSecret } from "../src/security.js";
import { createApp } from "../src/server.js";

function setup() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const config: GatewayConfig = {
    host: "127.0.0.1", port: 3000, baseUrl: "https://api.libertytools.test",
    managementApiToken: "management-test", erlcPublicKeySpkiBase64: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    webhookMaxClockSkewSeconds: 300, encryptionKey: crypto.randomBytes(32), forwardTimeoutMs: 1000,
    forwardMaxAttempts: 5, forwardRetryWindowMs: 900_000, workerPollMs: 100,
    erlcApiBaseUrl: "https://api.erlc.test/v2", erlcGlobalApiKey: "public-app-test-key", eventRetentionDays: 14, auditRetentionDays: 90, maintenanceIntervalMs: 3_600_000,
    hostedCommandsEnabled: true
  };
  const store = new MemoryGatewayStore();
  const managementHeaders = { authorization: "Bearer management-test", "x-liberty-account-id": "acct_a" };
  const sign = (payload: string, timestamp = String(Math.floor(Date.now() / 1000))) => {
    return {
      "content-type": "application/json",
      "x-signature-timestamp": timestamp,
      "x-signature-ed25519": crypto.sign(null, Buffer.concat([Buffer.from(timestamp), Buffer.from(payload)]), privateKey).toString("hex")
    };
  };
  return { config, store, managementHeaders, sign };
}

async function createConnection(app: Awaited<ReturnType<typeof createApp>>["app"], headers: Record<string, string>, name = "Main Server") {
  const response = await app.inject({ method: "POST", url: "/v1/management/connections", headers, payload: { name } });
  assert.equal(response.statusCode, 201, response.body);
  return response.json().connection as { id: string; publicId: string; ingestUrl: string };
}

test("server key validation uses the public app key and fails closed when it is missing", async () => {
  const value = setup();
  const requests: Headers[] = [];
  const fetchMock: typeof fetch = async (_input, init) => {
    requests.push(new Headers(init?.headers));
    return new Response(JSON.stringify({ Name: "Main" }), { status: 200 });
  };
  const { app } = await createApp({ config: value.config, store: value.store, fetch: fetchMock });
  const connection = await createConnection(app, value.managementHeaders);
  const url = `/v1/management/connections/${connection.id}/server-credential`;
  const input = { serverKey: "privatePart-PublicServerId" };
  delete value.config.erlcGlobalApiKey;
  const missing = await app.inject({ method: "PUT", url, headers: value.managementHeaders, payload: input });
  assert.equal(missing.statusCode, 503);
  assert.equal(missing.json().error.code, "erlc_global_key_missing");
  assert.equal(requests.length, 0);
  value.config.erlcGlobalApiKey = "public-app-test-key";
  const accepted = await app.inject({ method: "PUT", url, headers: value.managementHeaders, payload: input });
  assert.equal(accepted.statusCode, 200);
  assert.equal(requests[0]?.get("Authorization"), "public-app-test-key");
  assert.equal(requests[0]?.get("Server-Key"), "privatePart-PublicServerId");
  assert.equal(accepted.json().connection.server.id, "PublicServerId");
  assert.doesNotMatch(accepted.body, /public-app-test-key|privatePart/);
  await app.close();
});

test("existing encrypted server keys provide the authorization server ID without reconnecting", async () => {
  const value = setup();
  const { app } = await createApp({ config: value.config, store: value.store });
  const created = await createConnection(app, value.managementHeaders);
  const stored = await value.store.getConnection(created.id);
  assert.ok(stored);
  await value.store.updateConnection({
    ...stored,
    encryptedServerKey: encryptSecret("privatePart-PublicServerId", value.config.encryptionKey),
    serverName: "Main",
    serverId: "legacyNumericId"
  });
  const detail = await app.inject({ method: "GET", url: `/v1/management/connections/${created.id}`, headers: value.managementHeaders });
  assert.equal(detail.json().connection.server.id, "PublicServerId");
  assert.doesNotMatch(detail.body, /privatePart|legacyNumericId/);
  const list = await app.inject({ method: "GET", url: "/v1/management/connections", headers: value.managementHeaders });
  assert.equal(list.json().connections[0].server.id, "PublicServerId");
  assert.doesNotMatch(list.body, /privatePart|legacyNumericId/);
  await app.close();
});

test("server-key validation stops repeated provider requests from one account", async () => {
  const value = setup();
  let requests = 0;
  const fetchMock: typeof fetch = async () => { requests++; return new Response("{}", { status: 400 }); };
  const { app } = await createApp({ config: value.config, store: value.store, fetch: fetchMock });
  const connection = await createConnection(app, value.managementHeaders);
  const url = `/v1/management/connections/${connection.id}/server-credential`;
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await app.inject({ method: "PUT", url, headers: value.managementHeaders,
      payload: { serverKey: "invalid-PublicServerId" } });
    assert.equal(response.statusCode, 400);
  }
  const blocked = await app.inject({ method: "PUT", url, headers: value.managementHeaders,
    payload: { serverKey: "invalid-PublicServerId" } });
  assert.equal(blocked.statusCode, 429);
  assert.equal(requests, 6);
  await app.close();
});

test("management endpoints enforce authentication, ownership, and connection limits", async () => {
  const value = setup();
  const { app } = await createApp({ config: value.config, store: value.store });
  const legacyHealth = await app.inject({ method: "GET", url: "/health" });
  assert.equal(legacyHealth.statusCode, 200);
  assert.deepEqual(legacyHealth.json(), { status: "ok", service: "libertytools-gateway" });
  assert.equal((await app.inject({ method: "GET", url: "/v1/management/connections" })).statusCode, 401);
  const first = await createConnection(app, value.managementHeaders, "One");
  await createConnection(app, value.managementHeaders, "Two");
  const limited = await app.inject({ method: "POST", url: "/v1/management/connections", headers: value.managementHeaders, payload: { name: "Three" } });
  assert.equal(limited.statusCode, 409);
  assert.equal(limited.json().error.code, "limit_reached");
  const other = await app.inject({ method: "GET", url: `/v1/management/connections/${first.id}`, headers: { authorization: "Bearer management-test", "x-liberty-account-id": "acct_b" } });
  assert.equal(other.statusCode, 404);
  const malformedDelete = await app.inject({ method: "DELETE", url: `/v1/management/connections/${first.id}`,
    headers: { ...value.managementHeaders, "content-type": "application/json" } });
  assert.equal(malformedDelete.statusCode, 400);
  await app.close();
});

test("signed ingestion deduplicates and Poll subscriptions acknowledge independently", async () => {
  const value = setup();
  const { app } = await createApp({ config: value.config, store: value.store });
  const connection = await createConnection(app, value.managementHeaders);
  const subscriptions = [];
  for (const name of ["Bot A", "Bot B"]) {
    const response = await app.inject({
      method: "POST", url: `/v1/management/connections/${connection.id}/poll-subscriptions`,
      headers: value.managementHeaders, payload: { name }
    });
    assert.equal(response.statusCode, 201, response.body);
    subscriptions.push(response.json() as { subscription: { id: string }; pollToken: string });
  }
  const payload = JSON.stringify({ event: "CustomCommand", command: "help", argument: "", userId: "42", serverId: "server-1" });
  const ingest = await app.inject({ method: "POST", url: `/v1/ingest/${connection.publicId}`, headers: value.sign(payload), payload });
  assert.equal(ingest.statusCode, 202, ingest.body);
  assert.equal(ingest.json().duplicate, false);
  const duplicate = await app.inject({ method: "POST", url: `/v1/ingest/${connection.publicId}`, headers: value.sign(payload), payload });
  assert.equal(duplicate.json().duplicate, true);

  const firstList = await app.inject({ method: "GET", url: `/v1/poll/subscriptions/${subscriptions[0]!.subscription.id}/events`, headers: { authorization: `Bearer ${subscriptions[0]!.pollToken}` } });
  const secondList = await app.inject({ method: "GET", url: `/v1/poll/subscriptions/${subscriptions[1]!.subscription.id}/events`, headers: { authorization: `Bearer ${subscriptions[1]!.pollToken}` } });
  assert.equal(firstList.json().events.length, 1);
  assert.equal(secondList.json().events.length, 1);
  const eventId = firstList.json().events[0].id as string;
  const ack = await app.inject({ method: "POST", url: `/v1/poll/subscriptions/${subscriptions[0]!.subscription.id}/events/acknowledge`, headers: { authorization: `Bearer ${subscriptions[0]!.pollToken}` }, payload: { eventIds: [eventId] } });
  assert.deepEqual(ack.json().acknowledged, [eventId]);
  const firstAfter = await app.inject({ method: "GET", url: `/v1/poll/subscriptions/${subscriptions[0]!.subscription.id}/events`, headers: { authorization: `Bearer ${subscriptions[0]!.pollToken}` } });
  const secondAfter = await app.inject({ method: "GET", url: `/v1/poll/subscriptions/${subscriptions[1]!.subscription.id}/events`, headers: { authorization: `Bearer ${subscriptions[1]!.pollToken}` } });
  assert.equal(firstAfter.json().events.length, 0);
  assert.equal(secondAfter.json().events.length, 1);
  await app.close();
});

test("identical webhook bodies with different signed timestamps are separate events", async () => {
  const value = setup();
  const { app } = await createApp({ config: value.config, store: value.store });
  const connection = await createConnection(app, value.managementHeaders);
  const payload = JSON.stringify({ event: "CustomCommand", command: "help", userId: "42" });
  const timestamp = Math.floor(Date.now() / 1_000);
  const first = await app.inject({ method: "POST", url: `/v1/ingest/${connection.publicId}`,
    headers: value.sign(payload, String(timestamp)), payload });
  const second = await app.inject({ method: "POST", url: `/v1/ingest/${connection.publicId}`,
    headers: value.sign(payload, String(timestamp + 1)), payload });
  assert.equal(first.statusCode, 202);
  assert.equal(second.statusCode, 202);
  assert.equal(second.json().duplicate, false);
  assert.equal(value.store.events.size, 2);
  await app.close();
});

test("ER:LC batch envelopes become typed Poll events", async () => {
  const value = setup();
  const { app } = await createApp({ config: value.config, store: value.store });
  const connection = await createConnection(app, value.managementHeaders);
  const subscriptionResponse = await app.inject({
    method: "POST", url: `/v1/management/connections/${connection.id}/poll-subscriptions`,
    headers: value.managementHeaders, payload: { name: "Batch reader" }
  });
  const subscription = subscriptionResponse.json() as { subscription: { id: string }; pollToken: string };
  const payload = JSON.stringify({
    server: "server-123",
    events: [
      { event: "CustomCommand", origin: "42", timestamp: 1711281000, data: { command: "help", argument: "" } },
      { event: "WebhookProbe", origin: "global", timestamp: 1711281001, data: {} }
    ]
  });
  const ingest = await app.inject({ method: "POST", url: `/v1/ingest/${connection.publicId}`, headers: value.sign(payload), payload });
  assert.equal(ingest.statusCode, 202, ingest.body);
  assert.equal(ingest.json().eventIds.length, 2);

  const listed = await app.inject({
    method: "GET", url: `/v1/poll/subscriptions/${subscription.subscription.id}/events`,
    headers: { authorization: `Bearer ${subscription.pollToken}` }
  });
  const events = listed.json().events as Array<{ type: string; occurredAt: string; serverId: string; data: Record<string, unknown> }>;
  assert.equal(events.length, 2);
  const command = events.find(event => event.type === "CustomCommand");
  assert.equal(command?.data.command, "help");
  assert.equal(command?.data.userId, "42");
  assert.equal(command?.occurredAt, "2024-03-24T11:50:00.000Z");
  assert.equal(command?.serverId, "server-123");
  assert.ok(events.some(event => event.type === "WebhookProbe"));
  await app.close();
});

test("rejects invalid webhook signatures without storing an event", async () => {
  const value = setup();
  const { app } = await createApp({ config: value.config, store: value.store });
  const connection = await createConnection(app, value.managementHeaders);
  const response = await app.inject({
    method: "POST", url: `/v1/ingest/${connection.publicId}`,
    headers: { "content-type": "application/json", "x-signature-timestamp": String(Math.floor(Date.now() / 1000)), "x-signature-ed25519": "00" },
    payload: JSON.stringify({ event: "WebhookProbe" })
  });
  assert.equal(response.statusCode, 401, response.body);
  assert.equal(value.store.events.size, 0);
  await app.close();
});

test("rate limits repeated invalid signatures by source and public connection", async () => {
  const value = setup();
  const { app } = await createApp({ config: value.config, store: value.store });
  const connection = await createConnection(app, value.managementHeaders);
  for (let index = 0; index < 20; index += 1) {
    await value.store.takeRateLimit(`invalid-signature:127.0.0.1:${connection.publicId}`, 20, 600_000);
  }
  const response = await app.inject({ method: "POST", url: `/v1/ingest/${connection.publicId}`,
    headers: { "content-type": "application/json", "x-signature-timestamp": String(Math.floor(Date.now() / 1000)), "x-signature-ed25519": "00" },
    payload: JSON.stringify({ event: "WebhookProbe" }) });
  assert.equal(response.statusCode, 429, response.body);
  await app.close();
});

test("creates bounded HTTP destinations and rejects internal targets", async () => {
  const value = setup();
  const { app } = await createApp({ config: value.config, store: value.store });
  const connection = await createConnection(app, value.managementHeaders);
  const created = await app.inject({
    method: "POST", url: `/v1/management/connections/${connection.id}/destinations`, headers: value.managementHeaders,
    payload: { name: "Self hosted", type: "signedProxy", url: "http://8.8.8.8:3000/events" }
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().destination.transportSecurity, "unencrypted");
  assert.equal(created.json().destination.healthState, "probation");
  assert.match(created.json().signingSecret, /^lts_/);
  const blocked = await app.inject({
    method: "POST", url: `/v1/management/connections/${connection.id}/destinations`, headers: value.managementHeaders,
    payload: { name: "Internal", type: "rawMirror", url: "http://127.0.0.1:3000/events" }
  });
  assert.equal(blocked.statusCode, 400, blocked.body);
  assert.equal(blocked.json().error.code, "destination_blocked");
  await app.close();
});

test("rule builder dry-runs and publishes only after a server credential is configured", async () => {
  const value = setup();
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/server") && init?.method !== "POST") return new Response(JSON.stringify({ Id: "server-1", Name: "Main" }), { status: 200 });
    return new Response(JSON.stringify({ message: "Success" }), { status: 200 });
  };
  const { app } = await createApp({ config: value.config, store: value.store, fetch: fetchMock });
  const connection = await createConnection(app, value.managementHeaders);
  const created = await app.inject({
    method: "POST", url: `/v1/management/connections/${connection.id}/rules`, headers: value.managementHeaders,
    payload: { name: "Help", draft: { trigger: { type: "customCommand", command: ";help" }, conditions: [], actions: [{ type: "privateReply", message: "Hello {{player.username}}" }], cooldown: { durationMs: 5000, scope: "player" } } }
  });
  assert.equal(created.statusCode, 201, created.body);
  const rule = created.json().rule as { id: string; draftVersion: number };
  const dryRun = await app.inject({ method: "POST", url: `/v1/management/connections/${connection.id}/rules/${rule.id}/test`, headers: value.managementHeaders,
    payload: { type: "CustomCommand", data: { command: "help", username: "TestPlayer", userId: "1" } } });
  assert.equal(dryRun.json().matched, true);
  assert.match(dryRun.json().actions[0].preview, /^:pm TestPlayer/);
  const blockedPublish = await app.inject({ method: "POST", url: `/v1/management/connections/${connection.id}/rules/${rule.id}/publish`, headers: value.managementHeaders, payload: { draftVersion: rule.draftVersion } });
  assert.equal(blockedPublish.statusCode, 409);
  const credential = await app.inject({ method: "PUT", url: `/v1/management/connections/${connection.id}/server-credential`, headers: value.managementHeaders, payload: { serverKey: "server-key" } });
  assert.equal(credential.statusCode, 200, credential.body);
  const published = await app.inject({ method: "POST", url: `/v1/management/connections/${connection.id}/rules/${rule.id}/publish`, headers: value.managementHeaders, payload: { draftVersion: rule.draftVersion } });
  assert.equal(published.statusCode, 200, published.body);
  assert.equal(published.json().rule.enabled, true);
  await app.close();
});

test("management responses expose stable ingest URLs and delivery replay history", async () => {
  const value = setup();
  const { app } = await createApp({ config: value.config, store: value.store });
  const connection = await createConnection(app, value.managementHeaders);
  const listed = await app.inject({ method: "GET", url: "/v1/management/connections", headers: value.managementHeaders });
  assert.equal(listed.json().connections[0].ingestUrl, `https://api.libertytools.test/v1/ingest/${connection.publicId}`);
  const created = await app.inject({ method: "POST", url: `/v1/management/connections/${connection.id}/destinations`,
    headers: value.managementHeaders, payload: { name: "Proxy", type: "signedProxy", url: "https://8.8.8.8/events" } });
  const destination = created.json().destination as { id: string; secretPrefix: string };
  const rotated = await app.inject({ method: "POST", url: `/v1/management/connections/${connection.id}/destinations/${destination.id}/rotate-secret`, headers: value.managementHeaders });
  assert.equal(rotated.statusCode, 200, rotated.body);
  assert.notEqual(rotated.json().destination.secretPrefix, destination.secretPrefix);
  assert.match(rotated.json().signingSecret, /^lts_/);

  const now = new Date().toISOString();
  const event = normalizeTestEvent(connection.id, now);
  await value.store.saveEvent(event);
  await value.store.enqueueDelivery({ id: "del_test", destinationId: destination.id, eventId: event.id,
    attempt: 2, state: "failed", availableAt: now, createdAt: now, lastErrorCode: "http_500" });
  await value.store.recordDeliveryAttempt({ id: "att_test", deliveryId: "del_test", attemptedAt: now,
    statusCode: 500, latencyMs: 12, result: "failed", errorCode: "http_500" });
  const history = await app.inject({ method: "GET", url: `/v1/management/connections/${connection.id}/deliveries`, headers: value.managementHeaders });
  assert.equal(history.json().deliveries[0].attempts[0].statusCode, 500);
  const replay = await app.inject({ method: "POST", url: `/v1/management/connections/${connection.id}/deliveries/del_test/replay`, headers: value.managementHeaders });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(value.store.deliveries.get("del_test")?.state, "pending");
  assert.equal(value.store.deliveries.get("del_test")?.attempt, 0);
  await app.close();
});

test("published rule revisions can be inspected and rolled back", async () => {
  const value = setup();
  const fetchMock: typeof fetch = async input => String(input).endsWith("/server")
    ? new Response(JSON.stringify({ Id: "server-1", Name: "Main" }), { status: 200 })
    : new Response(JSON.stringify({ message: "Success" }), { status: 200 });
  const { app } = await createApp({ config: value.config, store: value.store, fetch: fetchMock });
  const connection = await createConnection(app, value.managementHeaders);
  await app.inject({ method: "PUT", url: `/v1/management/connections/${connection.id}/server-credential`, headers: value.managementHeaders, payload: { serverKey: "server-key" } });
  const firstDefinition = { trigger: { type: "customCommand", command: ";help" }, conditions: [], actions: [{ type: "privateReply", message: "First" }] };
  const created = await app.inject({ method: "POST", url: `/v1/management/connections/${connection.id}/rules`, headers: value.managementHeaders,
    payload: { name: "Help", draft: firstDefinition } });
  const rule = created.json().rule as { id: string; draftVersion: number };
  await app.inject({ method: "POST", url: `/v1/management/connections/${connection.id}/rules/${rule.id}/publish`, headers: value.managementHeaders, payload: { draftVersion: 1 } });
  const secondDefinition = { ...firstDefinition, actions: [{ type: "privateReply", message: "Second" }] };
  await app.inject({ method: "PUT", url: `/v1/management/connections/${connection.id}/rules/${rule.id}/draft`, headers: value.managementHeaders,
    payload: { draftVersion: 1, draft: secondDefinition } });
  await app.inject({ method: "POST", url: `/v1/management/connections/${connection.id}/rules/${rule.id}/publish`, headers: value.managementHeaders, payload: { draftVersion: 2 } });
  const detail = await app.inject({ method: "GET", url: `/v1/management/connections/${connection.id}/rules/${rule.id}`, headers: value.managementHeaders });
  assert.deepEqual(detail.json().revisions.map((item: { revision: number }) => item.revision), [2, 1]);
  const rollback = await app.inject({ method: "POST", url: `/v1/management/connections/${connection.id}/rules/${rule.id}/revisions/1/rollback`, headers: value.managementHeaders });
  assert.equal(rollback.json().rule.activeRevision, 3);
  assert.equal(rollback.json().rule.published.actions[0].message, "First");
  await app.close();
});

test("signed ingestion persists hosted-command jobs before a worker executes them", async () => {
  const value = setup();
  const commands: string[] = [];
  const fetchMock: typeof fetch = async (input, init) => {
    if (String(input).endsWith("/server") && init?.method !== "POST") return new Response(JSON.stringify({ Id: "server-1", Name: "Main" }), { status: 200 });
    if (String(input).endsWith("/server/command")) commands.push(String(JSON.parse(String(init?.body)).command));
    return new Response(JSON.stringify({ message: "Success" }), { status: 200 });
  };
  const { app, ruleWorker } = await createApp({ config: value.config, store: value.store, fetch: fetchMock });
  const connection = await createConnection(app, value.managementHeaders);
  await app.inject({ method: "PUT", url: `/v1/management/connections/${connection.id}/server-credential`, headers: value.managementHeaders, payload: { serverKey: "server-key" } });
  const created = await app.inject({ method: "POST", url: `/v1/management/connections/${connection.id}/rules`, headers: value.managementHeaders,
    payload: { name: "Help", draft: { trigger: { type: "customCommand", command: ";help" }, conditions: [], actions: [{ type: "privateReply", message: "Hi {{player.username}}" }], cooldown: { durationMs: 5000, scope: "player" } } } });
  const rule = created.json().rule as { id: string; draftVersion: number };
  await app.inject({ method: "POST", url: `/v1/management/connections/${connection.id}/rules/${rule.id}/publish`, headers: value.managementHeaders, payload: { draftVersion: 1 } });
  const payload = JSON.stringify({ event: "CustomCommand", command: "help", username: "TestPlayer", userId: "42", serverId: "server-1" });
  const ingest = await app.inject({ method: "POST", url: `/v1/ingest/${connection.publicId}`, headers: value.sign(payload), payload });
  assert.equal(ingest.statusCode, 202, ingest.body);
  assert.equal([...value.store.ruleJobs.values()][0]?.state, "pending");
  await ruleWorker.runOnce();
  assert.equal([...value.store.ruleJobs.values()][0]?.state, "succeeded");
  assert.deepEqual(commands, [":pm TestPlayer Hi TestPlayer"]);
  assert.equal(value.store.ruleExecutions[0]?.status, "succeeded");
  await app.close();
});

test("hosted command executions retain ERLC rejection details for dashboard troubleshooting", async () => {
  const value = setup();
  const fetchMock: typeof fetch = async (input, init) => {
    if (String(input).endsWith("/server") && init?.method !== "POST") {
      return new Response(JSON.stringify({ Id: "server-1", Name: "Main" }), { status: 200 });
    }
    if (String(input).includes("Players=true")) {
      return new Response(JSON.stringify({ Players: [{ Player: "TestPlayer:42" }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: 4000, message: "Allowlist this server IP." }), { status: 403 });
  };
  const { app, ruleWorker } = await createApp({ config: value.config, store: value.store, fetch: fetchMock });
  const connection = await createConnection(app, value.managementHeaders);
  await app.inject({ method: "PUT", url: `/v1/management/connections/${connection.id}/server-credential`, headers: value.managementHeaders, payload: { serverKey: "server-key" } });
  const created = await app.inject({
    method: "POST", url: `/v1/management/connections/${connection.id}/rules`, headers: value.managementHeaders,
    payload: { name: "Help", draft: { trigger: { type: "customCommand", command: "help" }, conditions: [], actions: [{ type: "privateReply", message: "Hi" }] } }
  });
  const rule = created.json().rule as { id: string };
  await app.inject({ method: "POST", url: `/v1/management/connections/${connection.id}/rules/${rule.id}/publish`, headers: value.managementHeaders, payload: { draftVersion: 1 } });
  const payload = JSON.stringify({ event: "CustomCommand", command: "help", userId: "42" });
  await app.inject({ method: "POST", url: `/v1/ingest/${connection.publicId}`, headers: value.sign(payload), payload });
  await ruleWorker.runOnce();
  assert.deepEqual(value.store.ruleExecutions[0]?.detail, {
    actions: [{ type: "privateReply", success: false, status: 403, code: "erlc_rejected", providerCode: 4000,
      message: "Allowlist this server IP." }]
  });
  assert.ok((await value.store.getConnection(connection.id))?.encryptedServerKey);
  await app.close();
});

test("hosted commands enforce the ERLC command interval across queued events", async () => {
  const value = setup();
  const commands: string[] = [];
  const fetchMock: typeof fetch = async (input, init) => {
    if (String(input).endsWith("/server") && init?.method !== "POST") {
      return new Response(JSON.stringify({ Id: "server-1", Name: "Main" }), { status: 200 });
    }
    if (String(input).endsWith("/server/command")) commands.push(String(JSON.parse(String(init?.body)).command));
    return new Response(JSON.stringify({ message: "Success" }), { status: 200 });
  };
  const { app, ruleWorker } = await createApp({ config: value.config, store: value.store, fetch: fetchMock });
  const connection = await createConnection(app, value.managementHeaders);
  await app.inject({ method: "PUT", url: `/v1/management/connections/${connection.id}/server-credential`,
    headers: value.managementHeaders, payload: { serverKey: "server-key" } });
  const created = await app.inject({ method: "POST", url: `/v1/management/connections/${connection.id}/rules`, headers: value.managementHeaders,
    payload: { name: "Help", draft: { trigger: { type: "customCommand", command: "help" }, conditions: [], actions: [{ type: "privateReply", message: "Hi" }] } } });
  await app.inject({ method: "POST", url: `/v1/management/connections/${connection.id}/rules/${created.json().rule.id}/publish`,
    headers: value.managementHeaders, payload: { draftVersion: 1 } });
  for (const userId of ["1", "2"]) {
    const payload = JSON.stringify({ event: "CustomCommand", command: "help", username: `Player${userId}`, userId });
    await app.inject({ method: "POST", url: `/v1/ingest/${connection.publicId}`, headers: value.sign(payload), payload });
  }
  await ruleWorker.runOnce();
  assert.deepEqual(commands, [":pm Player1 Hi"]);
  assert.deepEqual(value.store.ruleExecutions.map(item => item.status), ["succeeded", "rateLimited"]);
  assert.equal(value.store.ruleExecutions[1]?.detail.code, "rate_limited");
  assert.ok(Number(value.store.ruleExecutions[1]?.detail.retryAfterMs) > 0);
  await app.close();
});

test("hosted commands honor ERLC Retry-After without retrying the rejected command", async () => {
  const value = setup();
  let commandRequests = 0;
  const fetchMock: typeof fetch = async (input, init) => {
    if (String(input).endsWith("/server") && init?.method !== "POST") {
      return new Response(JSON.stringify({ Id: "server-1", Name: "Main" }), { status: 200 });
    }
    commandRequests += 1;
    return new Response(JSON.stringify({ code: 2002, message: "Slow down", retry_after: 30 }), {
      status: 429, headers: { "retry-after": "30" }
    });
  };
  const { app, ruleWorker } = await createApp({ config: value.config, store: value.store, fetch: fetchMock });
  const connection = await createConnection(app, value.managementHeaders);
  await app.inject({ method: "PUT", url: `/v1/management/connections/${connection.id}/server-credential`,
    headers: value.managementHeaders, payload: { serverKey: "server-key" } });
  const created = await app.inject({ method: "POST", url: `/v1/management/connections/${connection.id}/rules`, headers: value.managementHeaders,
    payload: { name: "Help", draft: { trigger: { type: "customCommand", command: "help" }, conditions: [], actions: [{ type: "privateReply", message: "Hi" }] } } });
  await app.inject({ method: "POST", url: `/v1/management/connections/${connection.id}/rules/${created.json().rule.id}/publish`,
    headers: value.managementHeaders, payload: { draftVersion: 1 } });
  for (const userId of ["1", "2"]) {
    const payload = JSON.stringify({ event: "CustomCommand", command: "help", username: `Player${userId}`, userId });
    await app.inject({ method: "POST", url: `/v1/ingest/${connection.publicId}`, headers: value.sign(payload), payload });
    await ruleWorker.runOnce();
  }
  assert.equal(commandRequests, 1);
  assert.equal(value.store.ruleExecutions[0]?.status, "rateLimited");
  assert.equal((value.store.ruleExecutions[0]?.detail.actions as Array<Record<string, unknown>>)[0]?.retryAfterMs, 30_000);
  assert.equal(value.store.ruleExecutions[1]?.status, "rateLimited");
  assert.ok((value.store.cooldowns.get("erlc:provider:global") ?? 0) > Date.now() + 25_000);
  await app.close();
});

test("legacy ingest and Poll paths adapt to a v2-backed connection", async () => {
  const value = setup();
  const { app } = await createApp({ config: value.config, store: value.store });
  const connection = await createConnection(app, value.managementHeaders);
  await app.inject({ method: "POST", url: `/v1/management/connections/${connection.id}/poll-subscriptions`,
    headers: value.managementHeaders, payload: { name: "Legacy LibertyJS" } });
  const payload = JSON.stringify({ event: "CustomCommand", command: "help", userId: "42" });
  const ingest = await app.inject({ method: "POST", url: `/webhook/erlc/${connection.publicId}`, headers: value.sign(payload), payload });
  assert.equal(ingest.statusCode, 202, ingest.body);
  const first = await app.inject({ method: "GET", url: `/webhook/${connection.publicId}/events` });
  assert.equal(first.json().events.length, 1);
  assert.equal(first.json().events[0].event, "CustomCommand");
  assert.equal(first.json().events[0].userId, "42");
  assert.equal(first.json().events[0].command, "help");
  const second = await app.inject({ method: "GET", url: `/webhook/${connection.publicId}/events` });
  assert.equal(second.json().events.length, 0);
  await app.close();
});

test("audits management mutations without request secrets and removes expired records", async () => {
  const value = setup();
  const { app, maintenanceWorker } = await createApp({ config: value.config, store: value.store });
  const connection = await createConnection(app, value.managementHeaders);
  const audit = await app.inject({ method: "GET", url: `/v1/management/audit?connectionId=${connection.id}`, headers: value.managementHeaders });
  assert.equal(audit.statusCode, 200, audit.body);
  assert.ok(value.store.auditEntries.some(entry => entry.action === "POST /v1/management/connections"));
  assert.equal(JSON.stringify(value.store.auditEntries).includes("management-test"), false);
  const old = "2020-01-01T00:00:00.000Z";
  const event = normalizeTestEvent(connection.id, old);
  event.id = "evt_old"; event.dedupeKey = "old-event";
  await value.store.saveEvent(event);
  await value.store.recordAudit({ id: "aud_old", accountId: "acct_a", connectionId: connection.id,
    action: "test", requestId: "req_old", statusCode: 200, createdAt: old });
  const removed = await maintenanceWorker.runOnce();
  assert.equal(removed.events, 1);
  assert.equal(removed.audit, 1);
  await app.close();
});

function normalizeTestEvent(connectionId: string, now: string) {
  const payload = { event: "CustomCommand", command: "help", userId: "1" };
  const rawBody = Buffer.from(JSON.stringify(payload));
  return {
    id: "evt_test", connectionId, type: "CustomCommand", occurredAt: now, receivedAt: now,
    data: { command: "help", userId: "1" }, rawBody, originalHeaders: {}, synthetic: true, dedupeKey: "test-event"
  };
}
