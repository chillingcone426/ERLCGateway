import fs from "node:fs/promises";
import path from "node:path";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { encodeCursor } from "./normalization.js";
import { eventMatchesSubscription } from "./memory-store.js";
import type { EventQuery, GatewayStore } from "./store.js";
import type {
  Connection,
  DeliveryAttempt,
  DeliveryJob,
  EventPage,
  ForwardDestination,
  GatewayEvent,
  PollSubscription,
  Rule,
  RuleExecution
} from "./types.js";

function iso(value: unknown) { return new Date(String(value)).toISOString(); }
function strings(value: unknown) { return Array.isArray(value) ? value.map(String) : []; }

function connectionFromRow(row: QueryResultRow): Connection {
  return {
    id: String(row.id), accountId: String(row.account_id), name: String(row.name), publicId: String(row.public_id),
    paused: Boolean(row.paused),
    ...(row.legacy_preset ? { legacyPreset: String(row.legacy_preset) as NonNullable<Connection["legacyPreset"]> } : {}),
    ...(row.server_id ? { serverId: String(row.server_id) } : {}),
    ...(row.server_name ? { serverName: String(row.server_name) } : {}),
    ...(row.encrypted_server_key ? { encryptedServerKey: String(row.encrypted_server_key) } : {}),
    ...(row.server_key_fingerprint ? { serverKeyFingerprint: String(row.server_key_fingerprint) } : {}),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    ...(row.deleted_at ? { deletedAt: iso(row.deleted_at) } : {})
  };
}

function subscriptionFromRow(row: QueryResultRow): PollSubscription {
  return {
    id: String(row.id), connectionId: String(row.connection_id), name: String(row.name),
    tokenHash: String(row.token_hash), tokenPrefix: String(row.token_prefix),
    eventTypes: strings(row.event_types), includedCommands: strings(row.included_commands),
    excludedCommands: strings(row.excluded_commands), createdAt: iso(row.created_at),
    ...(row.last_used_at ? { lastUsedAt: iso(row.last_used_at) } : {}),
    ...(row.revoked_at ? { revokedAt: iso(row.revoked_at) } : {})
  };
}

function destinationFromRow(row: QueryResultRow): ForwardDestination {
  return {
    id: String(row.id), connectionId: String(row.connection_id), name: String(row.name),
    type: String(row.type) as ForwardDestination["type"], url: String(row.url),
    ...(row.provider_preset ? { providerPreset: String(row.provider_preset) } : {}),
    ...(row.encrypted_secret ? { encryptedSecret: String(row.encrypted_secret) } : {}),
    ...(row.secret_prefix ? { secretPrefix: String(row.secret_prefix) } : {}),
    healthState: String(row.health_state) as ForwardDestination["healthState"],
    enabled: Boolean(row.enabled), transportSecurity: String(row.transport_security) as ForwardDestination["transportSecurity"],
    consecutiveFailures: Number(row.consecutive_failures), successfulDeliveries: Number(row.successful_deliveries),
    filter: row.filter as ForwardDestination["filter"], createdAt: iso(row.created_at), updatedAt: iso(row.updated_at)
  };
}

function eventFromRow(row: QueryResultRow): GatewayEvent {
  return {
    id: String(row.id), connectionId: String(row.connection_id), type: String(row.type),
    ...(row.original_type ? { originalType: String(row.original_type) } : {}),
    occurredAt: iso(row.occurred_at), receivedAt: iso(row.received_at),
    ...(row.server_id ? { serverId: String(row.server_id) } : {}),
    data: row.data as Record<string, unknown>, rawBody: Buffer.from(row.raw_body as Buffer),
    originalHeaders: row.original_headers as Record<string, string>, synthetic: Boolean(row.synthetic),
    dedupeKey: String(row.dedupe_key)
  };
}

function deliveryFromRow(row: QueryResultRow): DeliveryJob {
  return {
    id: String(row.id), destinationId: String(row.destination_id), eventId: String(row.event_id),
    attempt: Number(row.attempt), state: String(row.state) as DeliveryJob["state"],
    availableAt: iso(row.available_at), createdAt: iso(row.created_at),
    ...(row.last_error_code ? { lastErrorCode: String(row.last_error_code) } : {})
  };
}

function ruleFromRow(row: QueryResultRow): Rule {
  return {
    id: String(row.id), connectionId: String(row.connection_id), name: String(row.name), enabled: Boolean(row.enabled),
    draftVersion: Number(row.draft_version), draft: row.draft as Rule["draft"],
    ...(row.active_revision !== null && row.active_revision !== undefined ? { activeRevision: Number(row.active_revision) } : {}),
    ...(row.published ? { published: row.published as NonNullable<Rule["published"]> } : {}),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at)
  };
}

export class PostgresGatewayStore implements GatewayStore {
  readonly pool: Pool;
  constructor(connectionString: string) { this.pool = new Pool({ connectionString, max: 20 }); }

  async init() {
    const sql = await fs.readFile(path.join(process.cwd(), "migrations", "001_initial.sql"), "utf8");
    await this.pool.query(sql);
  }
  async close() { await this.pool.end(); }

  async createConnection(value: Connection) {
    await this.pool.query(`INSERT INTO connections
      (id, account_id, name, public_id, paused, legacy_preset, server_id, server_name, encrypted_server_key,
       server_key_fingerprint, created_at, updated_at, deleted_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [
      value.id, value.accountId, value.name, value.publicId, value.paused, value.legacyPreset ?? null,
      value.serverId ?? null, value.serverName ?? null, value.encryptedServerKey ?? null,
      value.serverKeyFingerprint ?? null, value.createdAt, value.updatedAt, value.deletedAt ?? null
    ]);
  }
  async listConnections(accountId: string) {
    const result = await this.pool.query("SELECT * FROM connections WHERE account_id=$1 AND deleted_at IS NULL ORDER BY created_at", [accountId]);
    return result.rows.map(connectionFromRow);
  }
  async getConnection(id: string) {
    const result = await this.pool.query("SELECT * FROM connections WHERE id=$1 AND deleted_at IS NULL", [id]);
    return result.rows[0] ? connectionFromRow(result.rows[0]) : undefined;
  }
  async getConnectionByPublicId(publicId: string) {
    const result = await this.pool.query("SELECT * FROM connections WHERE public_id=$1 AND deleted_at IS NULL", [publicId]);
    return result.rows[0] ? connectionFromRow(result.rows[0]) : undefined;
  }
  async updateConnection(value: Connection) {
    await this.pool.query(`UPDATE connections SET name=$2, paused=$3, legacy_preset=$4, server_id=$5,
      server_name=$6, encrypted_server_key=$7, server_key_fingerprint=$8, updated_at=$9 WHERE id=$1`, [
      value.id, value.name, value.paused, value.legacyPreset ?? null, value.serverId ?? null,
      value.serverName ?? null, value.encryptedServerKey ?? null, value.serverKeyFingerprint ?? null, value.updatedAt
    ]);
  }
  async deleteConnection(id: string, deletedAt: string) {
    await this.pool.query("UPDATE connections SET deleted_at=$2, paused=true, updated_at=$2 WHERE id=$1", [id, deletedAt]);
  }

  async createPollSubscription(value: PollSubscription) {
    await this.pool.query(`INSERT INTO poll_subscriptions
      (id, connection_id, name, token_hash, token_prefix, event_types, included_commands, excluded_commands, created_at, last_used_at, revoked_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [value.id, value.connectionId, value.name,
      value.tokenHash, value.tokenPrefix, JSON.stringify(value.eventTypes), JSON.stringify(value.includedCommands),
      JSON.stringify(value.excludedCommands), value.createdAt, value.lastUsedAt ?? null, value.revokedAt ?? null]);
  }
  async listPollSubscriptions(connectionId: string) {
    const result = await this.pool.query("SELECT * FROM poll_subscriptions WHERE connection_id=$1 ORDER BY created_at", [connectionId]);
    return result.rows.map(subscriptionFromRow);
  }
  async getPollSubscription(id: string) {
    const result = await this.pool.query("SELECT * FROM poll_subscriptions WHERE id=$1", [id]);
    return result.rows[0] ? subscriptionFromRow(result.rows[0]) : undefined;
  }
  async updatePollSubscription(value: PollSubscription) {
    await this.pool.query(`UPDATE poll_subscriptions SET name=$2, token_hash=$3, token_prefix=$4, event_types=$5,
      included_commands=$6, excluded_commands=$7, last_used_at=$8, revoked_at=$9 WHERE id=$1`, [value.id,
      value.name, value.tokenHash, value.tokenPrefix, JSON.stringify(value.eventTypes), JSON.stringify(value.includedCommands),
      JSON.stringify(value.excludedCommands), value.lastUsedAt ?? null, value.revokedAt ?? null]);
  }
  async deletePollSubscription(id: string) { await this.pool.query("DELETE FROM poll_subscriptions WHERE id=$1", [id]); }

  async createDestination(value: ForwardDestination) {
    await this.pool.query(`INSERT INTO forward_destinations
      (id, connection_id, name, type, url, provider_preset, encrypted_secret, secret_prefix, health_state, enabled,
       transport_security, consecutive_failures, successful_deliveries, filter, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`, [value.id, value.connectionId,
      value.name, value.type, value.url, value.providerPreset ?? null, value.encryptedSecret ?? null,
      value.secretPrefix ?? null, value.healthState, value.enabled, value.transportSecurity,
      value.consecutiveFailures, value.successfulDeliveries, JSON.stringify(value.filter), value.createdAt, value.updatedAt]);
  }
  async listDestinations(connectionId: string) {
    const result = await this.pool.query("SELECT * FROM forward_destinations WHERE connection_id=$1 ORDER BY created_at", [connectionId]);
    return result.rows.map(destinationFromRow);
  }
  async getDestination(id: string) {
    const result = await this.pool.query("SELECT * FROM forward_destinations WHERE id=$1", [id]);
    return result.rows[0] ? destinationFromRow(result.rows[0]) : undefined;
  }
  async updateDestination(value: ForwardDestination) {
    await this.pool.query(`UPDATE forward_destinations SET name=$2, type=$3, url=$4, provider_preset=$5,
      encrypted_secret=$6, secret_prefix=$7, health_state=$8, enabled=$9, transport_security=$10,
      consecutive_failures=$11, successful_deliveries=$12, filter=$13, updated_at=$14 WHERE id=$1`, [value.id,
      value.name, value.type, value.url, value.providerPreset ?? null, value.encryptedSecret ?? null,
      value.secretPrefix ?? null, value.healthState, value.enabled, value.transportSecurity,
      value.consecutiveFailures, value.successfulDeliveries, JSON.stringify(value.filter), value.updatedAt]);
  }
  async deleteDestination(id: string) { await this.pool.query("DELETE FROM forward_destinations WHERE id=$1", [id]); }

  async saveEvent(value: GatewayEvent) {
    const result = await this.pool.query(`INSERT INTO events
      (id, connection_id, type, original_type, occurred_at, received_at, server_id, data, raw_body, original_headers,
       synthetic, dedupe_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (connection_id, dedupe_key) DO NOTHING RETURNING *`, [value.id, value.connectionId, value.type,
      value.originalType ?? null, value.occurredAt, value.receivedAt, value.serverId ?? null, JSON.stringify(value.data),
      value.rawBody, JSON.stringify(value.originalHeaders), value.synthetic, value.dedupeKey]);
    if (result.rows[0]) return { inserted: true, event: eventFromRow(result.rows[0]) };
    const existing = await this.pool.query("SELECT * FROM events WHERE connection_id=$1 AND dedupe_key=$2", [value.connectionId, value.dedupeKey]);
    return { inserted: false, event: eventFromRow(existing.rows[0]) };
  }
  async getEvent(id: string) {
    const result = await this.pool.query("SELECT * FROM events WHERE id=$1", [id]);
    return result.rows[0] ? eventFromRow(result.rows[0]) : undefined;
  }
  async listEvents(connectionId: string, query: EventQuery): Promise<EventPage> {
    const values: unknown[] = [connectionId];
    const clauses = ["e.connection_id=$1"];
    if (query.cursor) {
      values.push(query.cursor.receivedAt, query.cursor.id);
      clauses.push(`(e.received_at > $${values.length - 1} OR (e.received_at = $${values.length - 1} AND e.id > $${values.length}))`);
    }
    if (query.type) { values.push(query.type); clauses.push(`e.type=$${values.length}`); }
    if (query.pendingForSubscriptionId) {
      values.push(query.pendingForSubscriptionId);
      clauses.push(`NOT EXISTS (SELECT 1 FROM poll_acknowledgements a WHERE a.subscription_id=$${values.length} AND a.event_id=e.id)`);
    }
    values.push(Math.min(query.limit + 1, 101));
    const result = await this.pool.query(`SELECT e.* FROM events e WHERE ${clauses.join(" AND ")}
      ORDER BY e.received_at, e.id LIMIT $${values.length}`, values);
    let events = result.rows.map(eventFromRow);
    if (query.pendingForSubscriptionId) {
      const subscription = await this.getPollSubscription(query.pendingForSubscriptionId);
      events = subscription ? events.filter(event => eventMatchesSubscription(event, subscription)) : [];
    }
    const hasMore = events.length > query.limit;
    const page = events.slice(0, query.limit);
    return {
      events: page, nextCursor: page.length ? encodeCursor(page[page.length - 1]!) : null, hasMore,
      pendingCount: query.pendingForSubscriptionId ? events.length : 0
    };
  }
  async acknowledgeEvents(subscriptionId: string, eventIds: string[], acknowledgedAt: string) {
    const subscription = await this.getPollSubscription(subscriptionId);
    const acknowledged: string[] = [], alreadyAcknowledged: string[] = [], unknown: string[] = [];
    for (const eventId of [...new Set(eventIds)]) {
      const event = await this.getEvent(eventId);
      if (!subscription || !event || event.connectionId !== subscription.connectionId || !eventMatchesSubscription(event, subscription)) {
        unknown.push(eventId); continue;
      }
      const result = await this.pool.query(`INSERT INTO poll_acknowledgements(subscription_id,event_id,acknowledged_at)
        VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING event_id`, [subscriptionId, eventId, acknowledgedAt]);
      (result.rowCount ? acknowledged : alreadyAcknowledged).push(eventId);
    }
    return { acknowledged, alreadyAcknowledged, unknown };
  }

  async enqueueDelivery(value: DeliveryJob) {
    const result = await this.pool.query(`INSERT INTO delivery_jobs(id,destination_id,event_id,attempt,state,available_at,created_at,last_error_code)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(destination_id,event_id) DO NOTHING RETURNING id`, [value.id,
      value.destinationId, value.eventId, value.attempt, value.state, value.availableAt, value.createdAt, value.lastErrorCode ?? null]);
    return Boolean(result.rowCount);
  }
  async countQueuedDeliveries(destinationId: string) {
    const result = await this.pool.query("SELECT count(*)::int count FROM delivery_jobs WHERE destination_id=$1 AND state IN ('pending','running')", [destinationId]);
    return Number(result.rows[0]?.count ?? 0);
  }
  async claimDeliveries(limit: number, now: string) {
    return this.transaction(async client => {
      const result = await client.query(`SELECT * FROM delivery_jobs WHERE state='pending' AND available_at <= $1
        ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT $2`, [now, limit]);
      if (!result.rows.length) return [];
      await client.query("UPDATE delivery_jobs SET state='running' WHERE id=ANY($1::text[])", [result.rows.map(row => row.id)]);
      return result.rows.map(row => deliveryFromRow({ ...row, state: "running" }));
    });
  }
  async updateDelivery(value: DeliveryJob) {
    await this.pool.query("UPDATE delivery_jobs SET attempt=$2,state=$3,available_at=$4,last_error_code=$5 WHERE id=$1", [
      value.id, value.attempt, value.state, value.availableAt, value.lastErrorCode ?? null]);
  }
  async recordDeliveryAttempt(value: DeliveryAttempt) {
    await this.pool.query(`INSERT INTO delivery_attempts(id,delivery_id,attempted_at,status_code,latency_ms,result,response_excerpt,error_code)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [value.id, value.deliveryId, value.attemptedAt, value.statusCode ?? null,
      value.latencyMs, value.result, value.responseExcerpt ?? null, value.errorCode ?? null]);
  }

  async createRule(value: Rule) {
    await this.pool.query(`INSERT INTO rules(id,connection_id,name,enabled,draft_version,draft,active_revision,published,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [value.id, value.connectionId, value.name, value.enabled,
      value.draftVersion, JSON.stringify(value.draft), value.activeRevision ?? null,
      value.published ? JSON.stringify(value.published) : null, value.createdAt, value.updatedAt]);
  }
  async listRules(connectionId: string) {
    const result = await this.pool.query("SELECT * FROM rules WHERE connection_id=$1 ORDER BY created_at", [connectionId]);
    return result.rows.map(ruleFromRow);
  }
  async getRule(id: string) {
    const result = await this.pool.query("SELECT * FROM rules WHERE id=$1", [id]);
    return result.rows[0] ? ruleFromRow(result.rows[0]) : undefined;
  }
  async updateRule(value: Rule) {
    await this.pool.query(`UPDATE rules SET name=$2,enabled=$3,draft_version=$4,draft=$5,active_revision=$6,
      published=$7,updated_at=$8 WHERE id=$1`, [value.id, value.name, value.enabled, value.draftVersion,
      JSON.stringify(value.draft), value.activeRevision ?? null, value.published ? JSON.stringify(value.published) : null,
      value.updatedAt]);
  }
  async deleteRule(id: string) { await this.pool.query("DELETE FROM rules WHERE id=$1", [id]); }
  async recordRuleExecution(value: RuleExecution) {
    await this.pool.query(`INSERT INTO rule_executions(id,rule_id,event_id,status,detail,created_at,completed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7)`, [value.id, value.ruleId, value.eventId, value.status,
      JSON.stringify(value.detail), value.createdAt, value.completedAt ?? null]);
  }
  async listRuleExecutions(connectionId: string) {
    const result = await this.pool.query(`SELECT x.* FROM rule_executions x JOIN rules r ON r.id=x.rule_id
      WHERE r.connection_id=$1 ORDER BY x.created_at DESC LIMIT 200`, [connectionId]);
    return result.rows.map(row => ({
      id: String(row.id), ruleId: String(row.rule_id), eventId: String(row.event_id),
      status: String(row.status) as RuleExecution["status"], detail: row.detail as Record<string, unknown>,
      createdAt: iso(row.created_at), ...(row.completed_at ? { completedAt: iso(row.completed_at) } : {})
    }));
  }

  async takeRateLimit(key: string, limit: number, windowMs: number, now = Date.now()) {
    return this.transaction(async client => {
      const result = await client.query("SELECT count,reset_at FROM rate_limits WHERE key=$1 FOR UPDATE", [key]);
      const row = result.rows[0];
      const resetAt = row ? new Date(row.reset_at).getTime() : 0;
      if (!row || resetAt <= now) {
        await client.query(`INSERT INTO rate_limits(key,count,reset_at) VALUES($1,1,$2)
          ON CONFLICT(key) DO UPDATE SET count=1,reset_at=$2`, [key, new Date(now + windowMs).toISOString()]);
        return { allowed: true, remaining: limit - 1, retryAfterMs: 0 };
      }
      const count = Number(row.count);
      if (count >= limit) return { allowed: false, remaining: 0, retryAfterMs: resetAt - now };
      await client.query("UPDATE rate_limits SET count=count+1 WHERE key=$1", [key]);
      return { allowed: true, remaining: limit - count - 1, retryAfterMs: 0 };
    });
  }
  async takeCooldown(key: string, durationMs: number, now = Date.now()) {
    return this.transaction(async client => {
      const result = await client.query("SELECT available_at FROM cooldowns WHERE key=$1 FOR UPDATE", [key]);
      const availableAt = result.rows[0] ? new Date(result.rows[0].available_at).getTime() : 0;
      if (availableAt > now) return { allowed: false, retryAfterMs: availableAt - now };
      await client.query(`INSERT INTO cooldowns(key,available_at) VALUES($1,$2)
        ON CONFLICT(key) DO UPDATE SET available_at=$2`, [key, new Date(now + durationMs).toISOString()]);
      return { allowed: true, retryAfterMs: 0 };
    });
  }

  private async transaction<T>(run: (client: PoolClient) => Promise<T>) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await run(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
