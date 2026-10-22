import assert from "node:assert/strict";
import test from "node:test";
import { ObjectId, type WithId } from "mongodb";
import { legacyEasyEvent } from "../src/forwarding.js";
import { mapLegacyQueuedEvent, planLegacyWebhook, type LegacyQueuedEvent, type LegacyWebhook } from "../src/mongodb-migration.js";

function webhook(value: Partial<LegacyWebhook>): WithId<LegacyWebhook> {
  return { _id: new ObjectId("65f1f1f1f1f1f1f1f1f1f1f1"), ...value };
}

test("plans Poll migration with the original public ID and a legacy adapter", () => {
  const plan = planLegacyWebhook(webhook({
    webhookId: "r4vP3v8Z2hLwq0oN", robloxID: "1234567890", username: "Example", mode: "poll",
    createdAt: new Date("2026-03-24T12:34:56.000Z")
  }), "2026-10-19T12:00:00.000Z");
  assert.equal(plan.error, undefined);
  assert.equal(plan.connection?.publicId, "r4vP3v8Z2hLwq0oN");
  assert.equal(plan.connection?.accountId, "1234567890");
  assert.equal(plan.connection?.legacyPreset, "poll");
  assert.equal(plan.subscription?.name, "Legacy Poll adapter");
  assert.equal(plan.subscription?.connectionId, plan.connection?.id);
});

test("maps old Proxy and Easy modes without changing their payload contracts", () => {
  const proxy = planLegacyWebhook(webhook({
    webhookId: "proxy-id", robloxID: "1", username: "Owner", mode: "proxy", webhookURL: "http://example.com/events"
  }));
  const easy = planLegacyWebhook(webhook({
    webhookId: "easy-id", robloxID: "1", username: "Owner", mode: "easy", webhookURL: "https://example.com/easy"
  }));
  assert.equal(proxy.destination?.type, "rawMirror");
  assert.equal(proxy.destination?.providerPreset, "legacy-proxy");
  assert.equal(easy.destination?.type, "legacyEasy");
  assert.equal(easy.destination?.providerPreset, "legacy-easy");

  const event = mapLegacyQueuedEvent({
    _id: new ObjectId("65f1f2f2f2f2f2f2f2f2f2f2"), webhookId: "easy-id", event: "CustomCommand",
    userId: "9988776655", timestamp: 1711281000, command: "help", username: "OfficerJane",
    createdAt: new Date("2026-03-24T12:35:03.000Z")
  } as WithId<LegacyQueuedEvent>, easy.connection!.id);
  assert.deepEqual(legacyEasyEvent(event), {
    event: "CustomCommand",
    userId: "9988776655",
    timestamp: 1711281000,
    username: "OfficerJane",
    command: "help"
  });

  const officialBody = Buffer.from(JSON.stringify({
    server: { id: "server-1", name: "Main" },
    events: [{ event: "CustomCommand", origin: "42", timestamp: 1711281000, data: { command: "help", extra: "kept" } }]
  }));
  assert.deepEqual(legacyEasyEvent({ ...event, rawBody: officialBody }), {
    event: "CustomCommand", userId: "42", timestamp: 1711281000, command: "help", extra: "kept",
    server: { id: "server-1", name: "Main" }
  });
});

test("queued event mapping is stable and preserves the old event for legacy Poll", () => {
  const source = {
    _id: new ObjectId("65f1f2f2f2f2f2f2f2f2f2f2"), webhookId: "poll-id", event: "PlayerJoined",
    userId: "9988776655", timestamp: 1711281000, player: "OfficerJane",
    createdAt: new Date("2026-03-24T12:35:03.000Z")
  } as WithId<LegacyQueuedEvent>;
  const first = mapLegacyQueuedEvent(source, "con_migrated", "2026-10-19T12:00:00.000Z");
  const second = mapLegacyQueuedEvent(source, "con_migrated", "2026-10-19T12:00:00.000Z");
  assert.equal(first.id, second.id);
  assert.equal(first.dedupeKey, second.dedupeKey);
  assert.equal(first.type, "PlayerJoin");
  assert.equal(first.originalType, "PlayerJoined");
  assert.equal(first.data.player, "OfficerJane");
  assert.equal(first.receivedAt, "2026-03-24T12:35:03.000Z");
});

test("invalid source rows are reported while bad destinations preserve the connection", () => {
  const missingOwner = planLegacyWebhook(webhook({ webhookId: "missing-owner", mode: "poll" }));
  assert.match(missingOwner.error ?? "", /robloxID/);
  const brokenDestination = planLegacyWebhook(webhook({
    webhookId: "broken-url", robloxID: "1", username: "Owner", mode: "easy", webhookURL: "not a url"
  }));
  assert.ok(brokenDestination.connection);
  assert.equal(brokenDestination.destination, undefined);
  assert.match(brokenDestination.warning ?? "", /invalid/);
});
