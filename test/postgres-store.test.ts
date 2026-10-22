import assert from "node:assert/strict";
import test from "node:test";
import { PostgresGatewayStore } from "../src/postgres-store.js";
import type { DeliveryJob, GatewayEvent } from "../src/types.js";

test("a fan-out insert failure rolls back the event transaction", async () => {
  const statements: string[] = [];
  let released = false;
  const client = {
    query: async (sql: string) => {
      statements.push(sql);
      if (sql.includes("INSERT INTO events")) return { rows: [{ id: "evt_1" }] };
      if (sql.includes("INSERT INTO delivery_jobs")) throw new Error("queue insert failed");
      return { rows: [] };
    },
    release: () => { released = true; }
  };
  const store = new PostgresGatewayStore("postgres://unused");
  Object.defineProperty(store, "pool", { value: { connect: async () => client } });
  const now = "2026-10-22T12:00:00.000Z";
  const event: GatewayEvent = { id: "evt_1", connectionId: "con_1", type: "CustomCommand",
    occurredAt: now, receivedAt: now, data: { command: "help" }, rawBody: Buffer.from("{}"),
    originalHeaders: {}, synthetic: false, dedupeKey: "dedupe" };
  const job: DeliveryJob = { id: "del_1", destinationId: "dst_1", eventId: event.id,
    attempt: 0, state: "pending", availableAt: now, createdAt: now };
  await assert.rejects(store.saveEventWithJobs(event, [job], []), /queue insert failed/);
  assert.equal(statements[0], "BEGIN");
  assert.equal(statements.at(-1), "ROLLBACK");
  assert.equal(statements.includes("COMMIT"), false);
  assert.equal(released, true);
});

test("filtered Poll pages apply subscription predicates before the SQL limit", async () => {
  const statements: string[] = [];
  const now = "2026-10-22T12:00:00.000Z";
  const store = new PostgresGatewayStore("postgres://unused");
  Object.defineProperty(store, "pool", { value: { query: async (sql: string) => {
    statements.push(sql);
    if (sql.includes("FROM poll_subscriptions")) return { rows: [{ id: "sub_1", connection_id: "con_1",
      name: "Filtered", token_hash: "hash", token_prefix: "prefix", event_types: ["CustomCommand"],
      included_commands: ["help"], excluded_commands: ["admin"], created_at: now }] };
    return { rows: [] };
  } } });
  const page = await store.listEvents("con_1", { limit: 10, pendingForSubscriptionId: "sub_1" });
  assert.deepEqual(page.events, []);
  const limitedQuery = statements.find(sql => sql.includes("ORDER BY e.received_at"));
  assert.ok(limitedQuery);
  assert.match(limitedQuery, /e\.type = ANY/);
  assert.match(limitedQuery, /included_commands|lower\(coalesce\(e\.data->>'command'/);
  assert.match(limitedQuery, /NOT \(lower\(coalesce\(e\.data->>'command'/);
  assert.ok(limitedQuery.indexOf("lower(coalesce") < limitedQuery.indexOf("LIMIT"));
});
