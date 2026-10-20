import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import type { GatewayConfig } from "../src/config.js";
import { enqueueEventDeliveries, ForwardingWorker } from "../src/forwarding.js";
import { MemoryGatewayStore } from "../src/memory-store.js";
import { encryptSecret } from "../src/security.js";
import type { Connection, ForwardDestination, GatewayEvent } from "../src/types.js";

function fixture() {
  const now = "2026-10-16T15:00:00.000Z";
  const store = new MemoryGatewayStore();
  const config: GatewayConfig = {
    host: "127.0.0.1", port: 3000, baseUrl: "http://localhost:3000", managementApiToken: "management-test",
    erlcPublicKeySpkiBase64: "unused", webhookMaxClockSkewSeconds: 300, encryptionKey: crypto.randomBytes(32),
    forwardTimeoutMs: 1000, forwardMaxAttempts: 5, forwardRetryWindowMs: 900_000, workerPollMs: 100,
    erlcApiBaseUrl: "https://api.erlc.gg/v2", eventRetentionDays: 14, auditRetentionDays: 90, maintenanceIntervalMs: 3_600_000
  };
  const connection: Connection = {
    id: "con_1", accountId: "acct_1", name: "Server", publicId: "pub_1", paused: false,
    createdAt: now, updatedAt: now
  };
  const rawBody = Buffer.from('{"event":"CustomCommand","command":"help"}');
  const event: GatewayEvent = {
    id: "evt_1", connectionId: connection.id, type: "CustomCommand", originalType: "CustomCommand",
    occurredAt: now, receivedAt: now, data: { command: "help", userId: "1" }, rawBody,
    originalHeaders: { "x-signature-timestamp": "1", "x-signature-ed25519": "abcd" },
    synthetic: false, dedupeKey: "dedupe"
  };
  return { store, config, connection, event, now };
}

test("raw mirror preserves exact body and official signature headers", async () => {
  const value = fixture();
  await value.store.createConnection(value.connection);
  await value.store.saveEvent(value.event);
  const destination: ForwardDestination = {
    id: "dst_1", connectionId: value.connection.id, name: "Mirror", type: "rawMirror",
    url: "http://8.8.8.8:3000/events", healthState: "probation", enabled: true,
    transportSecurity: "unencrypted", consecutiveFailures: 0, successfulDeliveries: 0,
    filter: { eventTypes: ["*"], commandPolicy: "all", includedCommands: [], excludedCommands: [] },
    createdAt: value.now, updatedAt: value.now
  };
  await value.store.createDestination(destination);
  await enqueueEventDeliveries(value.store, value.event, false, value.now);
  let captured: Parameters<NonNullable<ConstructorParameters<typeof ForwardingWorker>[0]["request"]>>[0] | undefined;
  const worker = new ForwardingWorker({
    store: value.store, config: value.config,
    request: async options => {
      captured = options;
      return { statusCode: 202, headers: {}, body: Buffer.from("accepted") };
    },
    now: () => new Date(value.now).getTime()
  });
  assert.equal(await worker.runOnce(), 1);
  assert.deepEqual(captured?.body, value.event.rawBody);
  assert.equal(captured?.headers["x-signature-timestamp"], "1");
  assert.equal(captured?.headers["x-signature-ed25519"], "abcd");
  assert.equal((await value.store.getDestination(destination.id))?.healthState, "active");
});

test("a raw batch is mirrored once while normalized events remain separate", async () => {
  const value = fixture();
  await value.store.createConnection(value.connection);
  await value.store.saveEvent(value.event);
  const destination: ForwardDestination = {
    id: "dst_batch", connectionId: value.connection.id, name: "Batch mirror", type: "rawMirror",
    url: "https://8.8.8.8/events", healthState: "probation", enabled: true,
    transportSecurity: "encrypted", consecutiveFailures: 0, successfulDeliveries: 0,
    filter: { eventTypes: ["*"], commandPolicy: "all", includedCommands: [], excludedCommands: [] },
    createdAt: value.now, updatedAt: value.now
  };
  await value.store.createDestination(destination);
  const skipped = await enqueueEventDeliveries(value.store, value.event, false, value.now, { rawBatchPrimary: false });
  assert.equal(skipped.enqueued.length, 0);
  assert.equal(skipped.skipped[0]?.reason, "raw_batch_already_forwarded");
  await enqueueEventDeliveries(value.store, value.event, false, value.now, { rawBatchPrimary: true });
  assert.equal(value.store.deliveries.size, 1);
});

test("signed proxy uses the decrypted secret and normalized body", async () => {
  const value = fixture();
  await value.store.createConnection(value.connection);
  await value.store.saveEvent(value.event);
  const secret = "lts_test-secret";
  const destination: ForwardDestination = {
    id: "dst_2", connectionId: value.connection.id, name: "Proxy", type: "signedProxy",
    url: "https://8.8.8.8/events", encryptedSecret: encryptSecret(secret, value.config.encryptionKey),
    healthState: "probation", enabled: true, transportSecurity: "encrypted", consecutiveFailures: 0,
    successfulDeliveries: 0, filter: { eventTypes: ["CustomCommand"], commandPolicy: "all", includedCommands: [], excludedCommands: [] },
    createdAt: value.now, updatedAt: value.now
  };
  await value.store.createDestination(destination);
  await enqueueEventDeliveries(value.store, value.event, false, value.now);
  let body: Uint8Array = new Uint8Array();
  let signature = "";
  const worker = new ForwardingWorker({
    store: value.store, config: value.config,
    request: async options => {
      body = options.body;
      signature = options.headers["x-liberty-signature"] ?? "";
      return { statusCode: 204, headers: {}, body: Buffer.alloc(0) };
    }, now: () => new Date(value.now).getTime()
  });
  await worker.runOnce();
  assert.match(Buffer.from(body).toString(), /"type":"CustomCommand"/);
  assert.match(signature, /^v1=[a-f0-9]{64}$/);
  assert.equal(Buffer.from(body).equals(value.event.rawBody), false);
});

test("probation destination pauses after five failed attempts", async () => {
  const value = fixture();
  let clock = new Date(value.now).getTime();
  await value.store.createConnection(value.connection);
  await value.store.saveEvent(value.event);
  const destination: ForwardDestination = {
    id: "dst_3", connectionId: value.connection.id, name: "Broken", type: "rawMirror",
    url: "http://8.8.8.8:3000/events", healthState: "probation", enabled: true,
    transportSecurity: "unencrypted", consecutiveFailures: 0, successfulDeliveries: 0,
    filter: { eventTypes: ["*"], commandPolicy: "all", includedCommands: [], excludedCommands: [] },
    createdAt: value.now, updatedAt: value.now
  };
  await value.store.createDestination(destination);
  await enqueueEventDeliveries(value.store, value.event, false, value.now);
  const worker = new ForwardingWorker({
    store: value.store, config: value.config,
    request: async () => ({ statusCode: 500, headers: {}, body: Buffer.from("no") }),
    now: () => clock, random: () => 0
  });
  for (let index = 0; index < 5; index += 1) {
    await worker.runOnce();
    clock += 60_000;
  }
  const result = await value.store.getDestination(destination.id);
  assert.equal(result?.healthState, "paused");
  assert.equal(result?.enabled, false);
  assert.equal(result?.consecutiveFailures, 5);
});
