import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import type { GatewayConfig } from "../src/config.js";
import { RUNTIME_LIMITS } from "../src/limits.js";
import { MemoryGatewayStore } from "../src/memory-store.js";
import { RuleEngine, validateRuleDefinition } from "../src/rules.js";
import { encryptSecret } from "../src/security.js";
import type { Connection, GatewayEvent, Rule } from "../src/types.js";

function fixture(action: "privateReply" | "announce", hostedCommandsEnabled = true) {
  let now = Date.parse("2026-10-20T12:00:00.000Z");
  const encryptionKey = crypto.randomBytes(32);
  const config: GatewayConfig = {
    host: "127.0.0.1", port: 3000, baseUrl: "https://api.libertytools.test",
    managementApiToken: "test", erlcPublicKeySpkiBase64: "unused", webhookMaxClockSkewSeconds: 300,
    encryptionKey, forwardTimeoutMs: 1000, forwardMaxAttempts: 5, forwardRetryWindowMs: 900_000,
    workerPollMs: 100, erlcApiBaseUrl: "https://api.erlc.test/v2", eventRetentionDays: 14,
    auditRetentionDays: 90, maintenanceIntervalMs: 3_600_000, hostedCommandsEnabled
  };
  const store = new MemoryGatewayStore();
  const connection: Connection = {
    id: "con_1", accountId: "acct_1", name: "Server", publicId: "pub_1", paused: false,
    encryptedServerKey: encryptSecret("server-key", encryptionKey), createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString()
  };
  const definition = {
    trigger: { type: "customCommand" as const, command: "help" }, conditions: [],
    actions: [{ type: action, message: "Hello" }]
  };
  const rule: Rule = {
    id: "rul_1", connectionId: connection.id, name: "Help", enabled: true, draftVersion: 1,
    draft: definition, activeRevision: 1, published: definition,
    createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString()
  };
  const event = (id: string): GatewayEvent => ({
    id, connectionId: connection.id, type: "CustomCommand", occurredAt: new Date(now).toISOString(),
    receivedAt: new Date(now).toISOString(), data: { command: "help", username: "TestPlayer", userId: id },
    rawBody: Buffer.from("{}"), originalHeaders: {}, synthetic: false, dedupeKey: id
  });
  return { config, store, connection, rule, event, now: () => now, advance: (ms: number) => { now += ms; } };
}

test("hosted actions only accept explicit custom-command triggers", () => {
  assert.throws(() => validateRuleDefinition({
    trigger: { type: "event", eventType: "PlayerJoined" }, conditions: [],
    actions: [{ type: "announce", message: "Hello" }]
  }), /require a custom command trigger/);
});

test("the hosted-command emergency switch prevents outbound requests", async () => {
  const value = fixture("privateReply", false);
  let requests = 0;
  const engine = new RuleEngine({ store: value.store, config: value.config, now: value.now,
    fetch: async () => { requests += 1; return new Response(null, { status: 200 }); } });
  await value.store.createConnection(value.connection);
  await value.store.createRule(value.rule);
  await engine.executeRule(value.rule, value.event("evt_1"));
  assert.equal(requests, 0);
  assert.equal(value.store.ruleExecutions[0]?.status, "skipped");
  assert.equal(value.store.ruleExecutions[0]?.detail.code, "hosted_commands_disabled");
});

test("server-wide announcements are limited to one per minute", async () => {
  const value = fixture("announce");
  const commands: string[] = [];
  const engine = new RuleEngine({ store: value.store, config: value.config, now: value.now,
    fetch: async (_input, init) => { commands.push(String(JSON.parse(String(init?.body)).command)); return new Response(null, { status: 200 }); } });
  await value.store.createConnection(value.connection);
  await value.store.createRule(value.rule);
  await engine.executeRule(value.rule, value.event("evt_1"));
  value.advance(RUNTIME_LIMITS.erlcCommandMinimumIntervalMs + 1);
  await engine.executeRule(value.rule, value.event("evt_2"));
  assert.deepEqual(commands, [":h Hello"]);
  assert.equal(value.store.ruleExecutions[1]?.detail.code, "announcement_rate_limited");
});

test("daily safety limits disable the command before another request is sent", async () => {
  const value = fixture("privateReply");
  let requests = 0;
  const engine = new RuleEngine({ store: value.store, config: value.config, now: value.now,
    fetch: async () => { requests += 1; return new Response(null, { status: 200 }); } });
  await value.store.createConnection(value.connection);
  await value.store.createRule(value.rule);
  for (let index = 0; index < RUNTIME_LIMITS.hostedActionsPerConnectionDay; index += 1) {
    await value.store.takeRateLimit(`actions:connection:${value.connection.id}:day`,
      RUNTIME_LIMITS.hostedActionsPerConnectionDay, 24 * 60 * 60_000, value.now());
  }
  await engine.executeRule(value.rule, value.event("evt_1"));
  assert.equal(requests, 0);
  assert.equal((await value.store.getRule(value.rule.id))?.enabled, false);
  assert.equal(value.store.ruleExecutions[0]?.detail.code, "safety_limit_reached");
  assert.equal(value.store.ruleExecutions[0]?.detail.circuitBreaker, true);
});
