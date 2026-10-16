import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import type { GatewayConfig } from "../src/config.js";
import { MemoryGatewayStore } from "../src/memory-store.js";
import { createApp } from "../src/server.js";

function setup() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const config: GatewayConfig = {
    host: "127.0.0.1", port: 3000, baseUrl: "https://api.libertytools.test",
    managementApiToken: "management-test", erlcPublicKeySpkiBase64: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    webhookMaxClockSkewSeconds: 300, encryptionKey: crypto.randomBytes(32), forwardTimeoutMs: 1000,
    forwardMaxAttempts: 5, forwardRetryWindowMs: 900_000, workerPollMs: 100,
    erlcApiBaseUrl: "https://api.erlc.test/v2"
  };
  const store = new MemoryGatewayStore();
  const managementHeaders = { authorization: "Bearer management-test", "x-liberty-account-id": "acct_a" };
  const sign = (payload: string) => {
    const timestamp = String(Math.floor(Date.now() / 1000));
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

test("management endpoints enforce authentication, ownership, and connection limits", async () => {
  const value = setup();
  const { app } = await createApp({ config: value.config, store: value.store });
  assert.equal((await app.inject({ method: "GET", url: "/v1/management/connections" })).statusCode, 401);
  const first = await createConnection(app, value.managementHeaders, "One");
  await createConnection(app, value.managementHeaders, "Two");
  const limited = await app.inject({ method: "POST", url: "/v1/management/connections", headers: value.managementHeaders, payload: { name: "Three" } });
  assert.equal(limited.statusCode, 409);
  assert.equal(limited.json().error.code, "limit_reached");
  const other = await app.inject({ method: "GET", url: `/v1/management/connections/${first.id}`, headers: { authorization: "Bearer management-test", "x-liberty-account-id": "acct_b" } });
  assert.equal(other.statusCode, 404);
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
    payload: { name: "Help", draft: { trigger: { type: "customCommand", command: ";help" }, conditions: [], actions: [{ type: "privateReply", message: "Hello {{player.username}}" }], cooldown: { durationMs: 2000, scope: "player" } } }
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
