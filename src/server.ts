import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import rawBody from "fastify-raw-body";
import type { GatewayConfig } from "./config.js";
import { erlcHeaders, erlcInternalServerId, erlcRetryAfterMs } from "./erlc.js";
import { planEventDeliveries, ForwardingWorker, legacyEasyEvent } from "./forwarding.js";
import { DEFAULT_LIMITS, RUNTIME_LIMITS } from "./limits.js";
import { decodeCursor, normalizeWebhookEvent, normalizeWebhookEvents } from "./normalization.js";
import { MaintenanceWorker } from "./maintenance.js";
import { monitorErlcFetch } from "./provider-telemetry.js";
import { RuleEngine, RuleWorker, normalizeCommand, validateRuleDefinition } from "./rules.js";
import {
  constantTimeEqual,
  createToken,
  decryptSecret,
  encryptSecret,
  hashToken,
  randomId,
  secretFingerprint,
  validateDestinationUrl,
  verifyErlcSignature
} from "./security.js";
import type { EventQuery, GatewayStore } from "./store.js";
import type { Connection, DestinationFilter, ForwardDestination, GatewayEvent, Rule } from "./types.js";

interface CreateAppOptions {
  config: GatewayConfig;
  store: GatewayStore;
  worker?: ForwardingWorker;
  ruleEngine?: RuleEngine;
  ruleWorker?: RuleWorker;
  fetch?: typeof globalThis.fetch;
  maintenanceWorker?: MaintenanceWorker;
  logger?: boolean;
}

class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly extra?: Record<string, unknown>) {
    super(message);
  }
}

function body(request: FastifyRequest) {
  return request.body && typeof request.body === "object" ? request.body as Record<string, unknown> : {};
}

function bearer(request: FastifyRequest) {
  const value = request.headers.authorization;
  return typeof value === "string" && value.startsWith("Bearer ") ? value.slice(7) : "";
}

function accountId(request: FastifyRequest) {
  const value = request.headers["x-liberty-account-id"];
  if (typeof value !== "string" || !value.trim()) throw new ApiError(401, "authentication_required", "Account identity is required.");
  return value.trim();
}

function string(value: unknown, name: string, maximum = 200) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw new ApiError(400, "validation_failed", `${name} is required and must be ${maximum} characters or fewer.`, { field: name });
  }
  return value.trim();
}

function stringArray(value: unknown, maximum = 50) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum || value.some(item => typeof item !== "string")) {
    throw new ApiError(400, "validation_failed", "Expected a bounded string array.");
  }
  return [...new Set(value.map(item => item.trim()).filter(Boolean))];
}

function destinationFilter(value: unknown): DestinationFilter {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const policy = input.commandPolicy ?? "all";
  if (!(["all", "exclude", "unmatchedHosted"] as unknown[]).includes(policy)) {
    throw new ApiError(400, "validation_failed", "commandPolicy is invalid.");
  }
  return {
    eventTypes: stringArray(input.eventTypes),
    commandPolicy: policy as DestinationFilter["commandPolicy"],
    includedCommands: stringArray(input.includedCommands).map(normalizeCommand).filter(Boolean),
    excludedCommands: stringArray(input.excludedCommands).map(normalizeCommand).filter(Boolean)
  };
}

function connectionJson(value: Connection, config: GatewayConfig, outputs?: { poll: number; destinations: ForwardDestination[]; rules: number }) {
  let serverId: string | undefined;
  if (value.encryptedServerKey) {
    try {
      serverId = erlcInternalServerId(decryptSecret(value.encryptedServerKey, config.encryptionKey));
    } catch {
      // Keep the connection visible if an older credential cannot be decrypted.
    }
    serverId ||= value.serverId;
  }
  return {
    id: value.id,
    name: value.name,
    publicId: value.publicId,
    ingestUrl: `${config.baseUrl}/v1/ingest/${value.publicId}`,
    paused: value.paused,
    ...(value.legacyPreset ? { legacyPreset: value.legacyPreset } : {}),
    ...(serverId ? { server: { id: serverId, ...(value.serverName ? { name: value.serverName } : {}) } } : {}),
    serverCredentialConfigured: Boolean(value.encryptedServerKey),
    ...(value.serverKeyFingerprint ? { serverKeyFingerprint: value.serverKeyFingerprint } : {}),
    ...(outputs ? {
      outputs: {
        pollSubscriptions: outputs.poll,
        signedProxyDestinations: outputs.destinations.filter(item => item.type === "signedProxy").length,
        rawMirrorDestinations: outputs.destinations.filter(item => item.type === "rawMirror").length,
        legacyEasyDestinations: outputs.destinations.filter(item => item.type === "legacyEasy").length,
        hostedAutomations: outputs.rules > 0,
        enabledRules: outputs.rules
      }
    } : {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  };
}

function destinationJson(value: ForwardDestination) {
  return {
    id: value.id, connectionId: value.connectionId, name: value.name, type: value.type, url: value.url,
    ...(value.providerPreset ? { providerPreset: value.providerPreset } : {}),
    ...(value.secretPrefix ? { secretPrefix: value.secretPrefix } : {}),
    healthState: value.healthState, enabled: value.enabled, transportSecurity: value.transportSecurity,
    consecutiveFailures: value.consecutiveFailures, successfulDeliveries: value.successfulDeliveries,
    filter: value.filter, createdAt: value.createdAt, updatedAt: value.updatedAt
  };
}

function eventJson(value: GatewayEvent, includeRaw = false) {
  return {
    id: value.id, connectionId: value.connectionId, type: value.type,
    ...(value.originalType ? { originalType: value.originalType } : {}),
    occurredAt: value.occurredAt, receivedAt: value.receivedAt,
    ...(value.serverId ? { serverId: value.serverId } : {}),
    data: value.data, synthetic: value.synthetic,
    ...(includeRaw ? { raw: value.rawBody.toString("utf8") } : {})
  };
}

async function ownedConnection(store: GatewayStore, id: string, owner: string) {
  const connection = await store.getConnection(id);
  if (!connection || connection.accountId !== owner) throw new ApiError(404, "connection_not_found", "Connection not found.");
  return connection;
}

export async function createApp(options: CreateAppOptions) {
  const { config, store } = options;
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: RUNTIME_LIMITS.maxInboundBytes });
  const fetcher = monitorErlcFetch(options.fetch ?? globalThis.fetch, store, config,
    () => app.log.error("ER:LC telemetry write failed"));
  const worker = options.worker ?? new ForwardingWorker({ store, config });
  const ruleEngine = options.ruleEngine ?? new RuleEngine({ store, config, fetch: fetcher });
  const ruleWorker = options.ruleWorker ?? new RuleWorker({ store, engine: ruleEngine, pollMs: config.workerPollMs });
  const maintenanceWorker = options.maintenanceWorker ?? new MaintenanceWorker({ store, config });

  await app.register(rawBody, { field: "rawBody", global: false, encoding: false,
    routes: ["/v1/ingest/:publicId", "/webhook/:publicId", "/webhook/erlc/:publicId"] });

  app.setErrorHandler((error, request, reply) => {
    const api = error instanceof ApiError ? error : undefined;
    const code = api?.code ?? (typeof error === "object" && error && "code" in error ? String(error.code) : "internal_error");
    const reportedStatus = typeof error === "object" && error && "statusCode" in error &&
      typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500
      ? error.statusCode : undefined;
    const status = api?.status ?? reportedStatus ?? (code === "destination_blocked" ? 400 : code === "cursor_invalid" ? 400 : 500);
    if (status >= 500) request.log.error({ err: error, requestId: request.id }, "request failed");
    void reply.code(status).send({ error: { code, message: api?.message ?? "Request failed.", requestId: request.id, ...(api?.extra ?? {}) } });
  });

  app.addHook("onRequest", async request => {
    if (!request.url.startsWith("/v1/management/")) return;
    if (!constantTimeEqual(bearer(request), config.managementApiToken)) {
      throw new ApiError(401, "authentication_required", "Management authentication failed.");
    }
    accountId(request);
  });

  app.addHook("onResponse", async (request, reply) => {
    if (!request.url.startsWith("/v1/management/") || ["GET", "HEAD", "OPTIONS"].includes(request.method) || reply.statusCode >= 500) return;
    const owner = request.headers["x-liberty-account-id"];
    if (typeof owner !== "string" || !owner.trim()) return;
    const params = request.params && typeof request.params === "object" ? request.params as Record<string, unknown> : {};
    try {
      await store.recordAudit({ id: randomId("aud"), accountId: owner.trim(),
        ...(typeof params.id === "string" ? { connectionId: params.id } : {}),
        action: `${request.method} ${request.routeOptions.url}`, requestId: request.id,
        statusCode: reply.statusCode, createdAt: new Date().toISOString() });
    } catch (error) { request.log.error({ err: error }, "audit write failed"); }
  });

  const liveHealth = async () => ({ status: "ok", service: "libertytools-gateway" });
  app.get("/health", liveHealth);
  app.get("/health/live", liveHealth);
  app.get("/health/ready", async (_request, reply) => {
    try {
      await store.listConnections("__healthcheck__");
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "not_ready" });
    }
  });

  app.get("/v1/management/connections", async request => {
    const owner = accountId(request);
    const connections = await store.listConnections(owner);
    const shaped = await Promise.all(connections.map(async connection => connectionJson(connection, config, {
      poll: (await store.listPollSubscriptions(connection.id)).length,
      destinations: await store.listDestinations(connection.id),
      rules: (await store.listRules(connection.id)).filter(rule => rule.enabled).length
    })));
    return { connections: shaped, usage: { connections: shaped.length }, limits: DEFAULT_LIMITS };
  });

  app.get<{ Querystring: { connectionId?: string; limit?: string } }>("/v1/management/audit", async request => {
    const owner = accountId(request);
    if (request.query.connectionId) await ownedConnection(store, request.query.connectionId, owner);
    const limit = Math.min(Math.max(Number(request.query.limit ?? 100), 1), 200);
    return { entries: await store.listAudit(owner, request.query.connectionId, limit) };
  });

  app.post("/v1/management/connections", async (request, reply) => {
    const owner = accountId(request);
    const existing = await store.listConnections(owner);
    if (existing.length >= DEFAULT_LIMITS.connections) {
      throw new ApiError(409, "limit_reached", "Connection limit reached.", {
        resource: "connections", limit: DEFAULT_LIMITS.connections, current: existing.length
      });
    }
    const input = body(request);
    const now = new Date().toISOString();
    const connection: Connection = {
      id: randomId("con"), accountId: owner, name: string(input.name, "name"), publicId: randomId("pub"),
      paused: false, createdAt: now, updatedAt: now,
      ...(["poll", "proxy", "easy"].includes(String(input.mode)) ? { legacyPreset: String(input.mode) as NonNullable<Connection["legacyPreset"]> } : {})
    };
    await store.createConnection(connection);
    return reply.code(201).send({ connection: connectionJson(connection, config), limits: DEFAULT_LIMITS });
  });

  app.get<{ Params: { id: string } }>("/v1/management/connections/:id", async request => {
    const connection = await ownedConnection(store, request.params.id, accountId(request));
    return { connection: connectionJson(connection, config, {
      poll: (await store.listPollSubscriptions(connection.id)).length,
      destinations: await store.listDestinations(connection.id),
      rules: (await store.listRules(connection.id)).filter(rule => rule.enabled).length
    }), limits: DEFAULT_LIMITS };
  });

  app.patch<{ Params: { id: string } }>("/v1/management/connections/:id", async request => {
    const connection = await ownedConnection(store, request.params.id, accountId(request));
    const input = body(request);
    const updated: Connection = {
      ...connection,
      ...(input.name !== undefined ? { name: string(input.name, "name") } : {}),
      ...(typeof input.paused === "boolean" ? { paused: input.paused } : {}),
      updatedAt: new Date().toISOString()
    };
    await store.updateConnection(updated);
    return { connection: connectionJson(updated, config) };
  });

  app.delete<{ Params: { id: string } }>("/v1/management/connections/:id", async (request, reply) => {
    const connection = await ownedConnection(store, request.params.id, accountId(request));
    const deletedAt = new Date().toISOString();
    await store.deleteConnection(connection.id, deletedAt);
    return reply.code(202).send({ deleted: true, connectionId: connection.id, deletedAt });
  });

  app.put<{ Params: { id: string } }>("/v1/management/connections/:id/server-credential", async request => {
    const owner = accountId(request);
    const connection = await ownedConnection(store, request.params.id, owner);
    const serverKey = string(body(request).serverKey, "serverKey", 500);
    if (!config.erlcGlobalApiKey) throw new ApiError(503, "erlc_global_key_missing", "LibertyTools has not configured its ER:LC public application key.");
    const pausedMs = await store.remainingCooldown("erlc:provider:global");
    if (pausedMs > 0) throw new ApiError(429, "rate_limited", "ER:LC requests are temporarily paused.", { retryAfterMs: pausedMs });
    const accountLimit = await store.takeRateLimit(`erlc:credential-validation:${owner}`, 6, 60 * 60_000);
    if (!accountLimit.allowed) throw new ApiError(429, "rate_limited", "Too many server-key checks. Try again later.", { retryAfterMs: accountLimit.retryAfterMs });
    const appLimit = await store.takeRateLimit("erlc:credential-validation:global", 20, 60_000);
    if (!appLimit.allowed) throw new ApiError(429, "rate_limited", "Server-key checks are temporarily busy.", { retryAfterMs: appLimit.retryAfterMs });
    const response = await fetcher(`${config.erlcApiBaseUrl}/server`, { headers: erlcHeaders(config, serverKey) });
    if (response.status === 429) {
      const retryAfterMs = erlcRetryAfterMs(response);
      await store.setCooldown("erlc:provider:global", retryAfterMs);
      throw new ApiError(429, "rate_limited", "ER:LC requests are temporarily paused.", { retryAfterMs });
    }
    if (!response.ok) {
      const error = await response.json().catch(() => ({})) as { code?: unknown } | null;
      if (error?.code === 2003 || error?.code === 2005) {
        await store.setCooldown("erlc:provider:global", 60 * 60_000);
        throw new ApiError(503, "erlc_global_key_invalid", "LibertyTools' ER:LC public application key was rejected.");
      }
      throw new ApiError(400, "credential_invalid", "ER:LC rejected the server key.");
    }
    const data = await response.json() as Record<string, unknown>;
    const internalServerId = erlcInternalServerId(serverKey);
    const updated: Connection = {
      ...connection,
      encryptedServerKey: encryptSecret(serverKey, config.encryptionKey),
      serverKeyFingerprint: secretFingerprint(serverKey),
      ...(internalServerId ? { serverId: internalServerId } :
        data.Id !== undefined ? { serverId: String(data.Id) } : {}),
      ...(typeof data.Name === "string" ? { serverName: data.Name } : {}),
      updatedAt: new Date().toISOString()
    };
    await store.updateConnection(updated);
    return { connection: connectionJson(updated, config) };
  });

  app.delete<{ Params: { id: string } }>("/v1/management/connections/:id/server-credential", async request => {
    const connection = await ownedConnection(store, request.params.id, accountId(request));
    const { encryptedServerKey: _encrypted, serverKeyFingerprint: _fingerprint, ...rest } = connection;
    const updated: Connection = { ...rest, updatedAt: new Date().toISOString() };
    await store.updateConnection(updated);
    return { connection: connectionJson(updated, config) };
  });

  app.get<{ Params: { id: string } }>("/v1/management/connections/:id/poll-subscriptions", async request => {
    const connection = await ownedConnection(store, request.params.id, accountId(request));
    const subscriptions = await store.listPollSubscriptions(connection.id);
    return { subscriptions: subscriptions.map(({ tokenHash: _hash, ...value }) => value), usage: subscriptions.length, limit: DEFAULT_LIMITS.pollSubscriptionsPerConnection };
  });

  app.post<{ Params: { id: string } }>("/v1/management/connections/:id/poll-subscriptions", async (request, reply) => {
    const connection = await ownedConnection(store, request.params.id, accountId(request));
    const subscriptions = await store.listPollSubscriptions(connection.id);
    if (subscriptions.length >= DEFAULT_LIMITS.pollSubscriptionsPerConnection) {
      throw new ApiError(409, "limit_reached", "Poll subscription limit reached.", {
        resource: "pollSubscriptions", limit: DEFAULT_LIMITS.pollSubscriptionsPerConnection, current: subscriptions.length
      });
    }
    const input = body(request);
    const credential = createToken("ltp");
    const subscription = {
      id: randomId("sub"), connectionId: connection.id, name: string(input.name ?? "LibertyJS", "name"),
      tokenHash: credential.hash, tokenPrefix: credential.prefix, eventTypes: stringArray(input.eventTypes),
      includedCommands: stringArray(input.includedCommands).map(normalizeCommand).filter(Boolean),
      excludedCommands: stringArray(input.excludedCommands).map(normalizeCommand).filter(Boolean),
      createdAt: new Date().toISOString()
    };
    await store.createPollSubscription(subscription);
    const { tokenHash: _hash, ...safe } = subscription;
    return reply.code(201).send({ subscription: safe, pollToken: credential.token });
  });

  app.post<{ Params: { id: string; subscriptionId: string } }>("/v1/management/connections/:id/poll-subscriptions/:subscriptionId/rotate", async request => {
    const connection = await ownedConnection(store, request.params.id, accountId(request));
    const subscription = await store.getPollSubscription(request.params.subscriptionId);
    if (!subscription || subscription.connectionId !== connection.id) throw new ApiError(404, "subscription_not_found", "Poll subscription not found.");
    const credential = createToken("ltp");
    const updated = { ...subscription, tokenHash: credential.hash, tokenPrefix: credential.prefix };
    await store.updatePollSubscription(updated);
    return { subscription: { ...updated, tokenHash: undefined }, pollToken: credential.token };
  });

  app.delete<{ Params: { id: string; subscriptionId: string } }>("/v1/management/connections/:id/poll-subscriptions/:subscriptionId", async (request, reply) => {
    const connection = await ownedConnection(store, request.params.id, accountId(request));
    const subscription = await store.getPollSubscription(request.params.subscriptionId);
    if (!subscription || subscription.connectionId !== connection.id) throw new ApiError(404, "subscription_not_found", "Poll subscription not found.");
    await store.deletePollSubscription(subscription.id);
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>("/v1/management/connections/:id/destinations", async request => {
    const connection = await ownedConnection(store, request.params.id, accountId(request));
    const destinations = await store.listDestinations(connection.id);
    return { destinations: destinations.map(destinationJson), usage: destinations.length, limit: DEFAULT_LIMITS.forwardDestinationsPerConnection };
  });

  app.post<{ Params: { id: string } }>("/v1/management/connections/:id/destinations", async (request, reply) => {
    const owner = accountId(request);
    const connection = await ownedConnection(store, request.params.id, owner);
    const changeLimit = await store.takeRateLimit(`destination-change:${owner}`, RUNTIME_LIMITS.destinationChangesPerHour, 60 * 60_000);
    if (!changeLimit.allowed) throw new ApiError(429, "rate_limited", "Destination change limit reached.", { retryAfterSeconds: Math.ceil(changeLimit.retryAfterMs / 1000) });
    const destinations = await store.listDestinations(connection.id);
    if (destinations.length >= DEFAULT_LIMITS.forwardDestinationsPerConnection) {
      throw new ApiError(409, "limit_reached", "Forward destination limit reached.", {
        resource: "forwardDestinations", limit: DEFAULT_LIMITS.forwardDestinationsPerConnection, current: destinations.length
      });
    }
    const input = body(request);
    const type = input.type;
    if (type !== "signedProxy" && type !== "rawMirror") throw new ApiError(400, "validation_failed", "Destination type is invalid.");
    if (type === "rawMirror" && destinations.filter(value => value.type === "rawMirror").length >= DEFAULT_LIMITS.rawMirrorsPerConnection) {
      throw new ApiError(409, "limit_reached", "Raw mirror limit reached.", { resource: "rawMirrors", limit: DEFAULT_LIMITS.rawMirrorsPerConnection });
    }
    const url = string(input.url, "url", 2048);
    const validated = await validateDestinationUrl(url);
    const now = new Date().toISOString();
    const secret = type === "signedProxy" ? createToken("lts") : undefined;
    const destination: ForwardDestination = {
      id: randomId("dst"), connectionId: connection.id, name: string(input.name, "name"), type, url: validated.url.toString(),
      ...(typeof input.providerPreset === "string" && input.providerPreset.trim() ? { providerPreset: input.providerPreset.trim() } : {}),
      ...(secret ? { encryptedSecret: encryptSecret(secret.token, config.encryptionKey), secretPrefix: secret.prefix } : {}),
      healthState: "probation", enabled: true, transportSecurity: validated.transportSecurity,
      consecutiveFailures: 0, successfulDeliveries: 0, filter: destinationFilter(input.filter), createdAt: now, updatedAt: now
    };
    await store.createDestination(destination);
    return reply.code(201).send({
      destination: destinationJson(destination), ...(secret ? { signingSecret: secret.token } : {}),
      limits: { probationAttempts: RUNTIME_LIMITS.probationAttempts }
    });
  });

  app.patch<{ Params: { id: string; destinationId: string } }>("/v1/management/connections/:id/destinations/:destinationId", async request => {
    const owner = accountId(request);
    const connection = await ownedConnection(store, request.params.id, owner);
    const destination = await store.getDestination(request.params.destinationId);
    if (!destination || destination.connectionId !== connection.id) throw new ApiError(404, "destination_not_found", "Destination not found.");
    const input = body(request);
    let updated = { ...destination };
    if (input.url !== undefined && input.url !== destination.url) {
      const rate = await store.takeRateLimit(`destination-change:${owner}`, RUNTIME_LIMITS.destinationChangesPerHour, 60 * 60_000);
      if (!rate.allowed) throw new ApiError(429, "rate_limited", "Destination change limit reached.", { retryAfterSeconds: Math.ceil(rate.retryAfterMs / 1000) });
      const validated = await validateDestinationUrl(string(input.url, "url", 2048));
      updated = { ...updated, url: validated.url.toString(), transportSecurity: validated.transportSecurity,
        healthState: "probation", enabled: true, consecutiveFailures: 0, successfulDeliveries: 0 };
    }
    if (input.name !== undefined) updated.name = string(input.name, "name");
    if (typeof input.enabled === "boolean") updated.enabled = input.enabled;
    if (input.filter !== undefined) updated.filter = destinationFilter(input.filter);
    updated.updatedAt = new Date().toISOString();
    await store.updateDestination(updated);
    return { destination: destinationJson(updated) };
  });

  app.delete<{ Params: { id: string; destinationId: string } }>("/v1/management/connections/:id/destinations/:destinationId", async (request, reply) => {
    const connection = await ownedConnection(store, request.params.id, accountId(request));
    const destination = await store.getDestination(request.params.destinationId);
    if (!destination || destination.connectionId !== connection.id) throw new ApiError(404, "destination_not_found", "Destination not found.");
    await store.deleteDestination(destination.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string; destinationId: string } }>("/v1/management/connections/:id/destinations/:destinationId/test", async request => {
    const owner = accountId(request);
    const connection = await ownedConnection(store, request.params.id, owner);
    const destination = await store.getDestination(request.params.destinationId);
    if (!destination || destination.connectionId !== connection.id) throw new ApiError(404, "destination_not_found", "Destination not found.");
    const rate = await store.takeRateLimit(`destination-test:${owner}`, RUNTIME_LIMITS.destinationTestsPerTenMinutes, 10 * 60_000);
    if (!rate.allowed) throw new ApiError(429, "rate_limited", "Destination test limit reached.", { retryAfterSeconds: Math.ceil(rate.retryAfterMs / 1000) });
    const now = new Date().toISOString();
    const payload = { event: "WebhookProbe", type: "WebhookProbe", timestamp: now, synthetic: true };
    const raw = Buffer.from(JSON.stringify(payload));
    const event = normalizeWebhookEvent({ connectionId: connection.id, rawBody: raw, payload, headers: {}, receivedAt: now, synthetic: true });
    await store.saveEvent(event);
    await store.updateDestination({ ...destination, enabled: true, healthState: "probation", updatedAt: now });
    await store.enqueueDelivery({ id: randomId("del"), destinationId: destination.id, eventId: event.id,
      attempt: 0, state: "pending", availableAt: now, createdAt: now });
    await worker.runOnce();
    const result = await store.getDestination(destination.id);
    return { destination: result ? destinationJson(result) : null, accepted: result?.healthState === "active" };
  });

  app.post<{ Params: { id: string; destinationId: string } }>("/v1/management/connections/:id/destinations/:destinationId/resume", async request => {
    const connection = await ownedConnection(store, request.params.id, accountId(request));
    const destination = await store.getDestination(request.params.destinationId);
    if (!destination || destination.connectionId !== connection.id) throw new ApiError(404, "destination_not_found", "Destination not found.");
    if (destination.healthState !== "active") throw new ApiError(409, "destination_paused", "Run a successful destination test before resuming.");
    const updated = { ...destination, enabled: true, updatedAt: new Date().toISOString() };
    await store.updateDestination(updated);
    return { destination: destinationJson(updated) };
  });

  app.post<{ Params: { id: string; destinationId: string } }>("/v1/management/connections/:id/destinations/:destinationId/rotate-secret", async request => {
    const connection = await ownedConnection(store, request.params.id, accountId(request));
    const destination = await store.getDestination(request.params.destinationId);
    if (!destination || destination.connectionId !== connection.id) throw new ApiError(404, "destination_not_found", "Destination not found.");
    if (destination.type !== "signedProxy") throw new ApiError(409, "validation_failed", "Only signed Proxy destinations have signing secrets.");
    const credential = createToken("lts");
    const updated = { ...destination, encryptedSecret: encryptSecret(credential.token, config.encryptionKey),
      secretPrefix: credential.prefix, updatedAt: new Date().toISOString() };
    await store.updateDestination(updated);
    return { destination: destinationJson(updated), signingSecret: credential.token };
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>("/v1/management/connections/:id/deliveries", async request => {
    const connection = await ownedConnection(store, request.params.id, accountId(request));
    const limit = Math.min(Math.max(Number(request.query.limit ?? 50), 1), 100);
    return { deliveries: await store.listDeliveries(connection.id, limit) };
  });

  app.get<{ Params: { id: string; deliveryId: string } }>("/v1/management/connections/:id/deliveries/:deliveryId", async request => {
    const connection = await ownedConnection(store, request.params.id, accountId(request));
    const delivery = await store.getDelivery(request.params.deliveryId);
    if (!delivery || delivery.connectionId !== connection.id) throw new ApiError(404, "delivery_not_found", "Delivery not found.");
    return { delivery };
  });

  app.post<{ Params: { id: string; deliveryId: string } }>("/v1/management/connections/:id/deliveries/:deliveryId/replay", async request => {
    const owner = accountId(request);
    const connection = await ownedConnection(store, request.params.id, owner);
    const delivery = await store.getDelivery(request.params.deliveryId);
    if (!delivery || delivery.connectionId !== connection.id) throw new ApiError(404, "delivery_not_found", "Delivery not found.");
    if (delivery.state === "pending" || delivery.state === "running") throw new ApiError(409, "delivery_in_progress", "Delivery is already in progress.");
    const rate = await store.takeRateLimit(`delivery-replay:${owner}`, 20, 60 * 60_000);
    if (!rate.allowed) throw new ApiError(429, "rate_limited", "Delivery replay limit reached.", { retryAfterSeconds: Math.ceil(rate.retryAfterMs / 1000) });
    const now = new Date().toISOString();
    await store.updateDelivery({ id: delivery.id, destinationId: delivery.destinationId, eventId: delivery.eventId,
      attempt: 0, state: "pending", availableAt: now, createdAt: now });
    return { replayed: true, deliveryId: delivery.id };
  });

  app.get<{ Params: { id: string }; Querystring: { cursor?: string; limit?: string; type?: string; includeRaw?: string } }>("/v1/management/connections/:id/events", async request => {
    const connection = await ownedConnection(store, request.params.id, accountId(request));
    const limit = Math.min(Math.max(Number(request.query.limit ?? 50), 1), 100);
    const query: EventQuery = { limit };
    const cursor = decodeCursor(request.query.cursor);
    if (cursor) query.cursor = cursor;
    if (request.query.type) query.type = request.query.type;
    const page = await store.listEvents(connection.id, query);
    return { ...page, events: page.events.map(event => eventJson(event, request.query.includeRaw === "true")) };
  });

  app.post<{ Params: { id: string } }>("/v1/management/connections/:id/test-events", async (request, reply) => {
    const connection = await ownedConnection(store, request.params.id, accountId(request));
    const input = body(request);
    const payload = { event: input.type ?? "CustomCommand", type: input.type ?? "CustomCommand", data: input.data ?? {},
      synthetic: true, sampleId: randomId("sample") };
    const raw = Buffer.from(JSON.stringify(payload));
    const event = normalizeWebhookEvent({ connectionId: connection.id, rawBody: raw, payload, headers: {}, synthetic: true });
    const matchingRules = await ruleEngine.matchingRules(event);
    const saved = input.dryRun === true ? await store.saveEvent(event) :
      await store.saveEventWithJobs(event,
        (await planEventDeliveries(store, event, matchingRules.length > 0)).jobs,
        ruleEngine.planJobs(event, matchingRules));
    return reply.code(202).send({ accepted: true, event: eventJson(saved.event), dryRun: input.dryRun === true });
  });

  app.get<{ Params: { id: string } }>("/v1/management/connections/:id/rules", async request => {
    const connection = await ownedConnection(store, request.params.id, accountId(request));
    const rules = await store.listRules(connection.id);
    return { rules, usage: rules.length, limit: DEFAULT_LIMITS.rulesPerConnection };
  });

  app.get<{ Params: { id: string; ruleId: string } }>("/v1/management/connections/:id/rules/:ruleId", async request => {
    const connection = await ownedConnection(store, request.params.id, accountId(request));
    const rule = await store.getRule(request.params.ruleId);
    if (!rule || rule.connectionId !== connection.id) throw new ApiError(404, "rule_not_found", "Rule not found.");
    return { rule, revisions: await store.listRuleRevisions(rule.id) };
  });

  app.post<{ Params: { id: string } }>("/v1/management/connections/:id/rules", async (request, reply) => {
    const connection = await ownedConnection(store, request.params.id, accountId(request));
    const rules = await store.listRules(connection.id);
    if (rules.length >= DEFAULT_LIMITS.rulesPerConnection) throw new ApiError(409, "limit_reached", "Rule limit reached.");
    const input = body(request);
    const now = new Date().toISOString();
    const rule: Rule = {
      id: randomId("rul"), connectionId: connection.id, name: string(input.name, "name"), enabled: false,
      draftVersion: 1, draft: validateRuleDefinition(input.draft, {
        conditions: DEFAULT_LIMITS.conditionsPerRule, actions: DEFAULT_LIMITS.actionsPerRule
      }), createdAt: now, updatedAt: now
    };
    await store.createRule(rule);
    return reply.code(201).send({ rule });
  });

  app.put<{ Params: { id: string; ruleId: string } }>("/v1/management/connections/:id/rules/:ruleId/draft", async request => {
    const connection = await ownedConnection(store, request.params.id, accountId(request));
    const rule = await store.getRule(request.params.ruleId);
    if (!rule || rule.connectionId !== connection.id) throw new ApiError(404, "rule_not_found", "Rule not found.");
    const input = body(request);
    if (input.draftVersion !== rule.draftVersion) throw new ApiError(409, "draft_conflict", "The draft changed. Reload and try again.");
    const updated: Rule = { ...rule,
      ...(input.name !== undefined ? { name: string(input.name, "name") } : {}),
      draft: validateRuleDefinition(input.draft, { conditions: DEFAULT_LIMITS.conditionsPerRule, actions: DEFAULT_LIMITS.actionsPerRule }),
      draftVersion: rule.draftVersion + 1, updatedAt: new Date().toISOString()
    };
    await store.updateRule(updated);
    return { rule: updated };
  });

  app.post<{ Params: { id: string; ruleId: string } }>("/v1/management/connections/:id/rules/:ruleId/test", async request => {
    const connection = await ownedConnection(store, request.params.id, accountId(request));
    const rule = await store.getRule(request.params.ruleId);
    if (!rule || rule.connectionId !== connection.id) throw new ApiError(404, "rule_not_found", "Rule not found.");
    const input = body(request);
    const payload = { event: input.type ?? "CustomCommand", type: input.type ?? "CustomCommand", data: input.data ?? { userId: "test-user", username: "TestPlayer", command: "help", argument: "" } };
    const raw = Buffer.from(JSON.stringify(payload));
    const event = normalizeWebhookEvent({ connectionId: connection.id, rawBody: raw, payload, headers: {}, synthetic: true });
    return await ruleEngine.dryRun(rule.draft, event);
  });

  app.post<{ Params: { id: string; ruleId: string } }>("/v1/management/connections/:id/rules/:ruleId/publish", async request => {
    const connection = await ownedConnection(store, request.params.id, accountId(request));
    const rule = await store.getRule(request.params.ruleId);
    if (!rule || rule.connectionId !== connection.id) throw new ApiError(404, "rule_not_found", "Rule not found.");
    if (body(request).draftVersion !== rule.draftVersion) throw new ApiError(409, "draft_conflict", "The draft changed. Reload and try again.");
    if (!connection.encryptedServerKey) throw new ApiError(409, "credential_invalid", "Connect an ER:LC server key before publishing hosted actions.");
    const updated: Rule = { ...rule, enabled: true, activeRevision: (rule.activeRevision ?? 0) + 1,
      published: rule.draft, updatedAt: new Date().toISOString() };
    await store.updateRule(updated);
    await store.createRuleRevision({ ruleId: rule.id, revision: updated.activeRevision!, definition: rule.draft, publishedAt: updated.updatedAt });
    return { rule: updated };
  });

  app.post<{ Params: { id: string; ruleId: string; revision: string } }>("/v1/management/connections/:id/rules/:ruleId/revisions/:revision/rollback", async request => {
    const connection = await ownedConnection(store, request.params.id, accountId(request));
    const rule = await store.getRule(request.params.ruleId);
    if (!rule || rule.connectionId !== connection.id) throw new ApiError(404, "rule_not_found", "Rule not found.");
    if (!connection.encryptedServerKey) throw new ApiError(409, "credential_invalid", "Connect an ER:LC server key before publishing hosted actions.");
    const revision = await store.getRuleRevision(rule.id, Number(request.params.revision));
    if (!revision) throw new ApiError(404, "revision_not_found", "Rule revision not found.");
    const now = new Date().toISOString();
    const nextRevision = (rule.activeRevision ?? 0) + 1;
    const updated: Rule = { ...rule, enabled: true, draft: revision.definition, draftVersion: rule.draftVersion + 1,
      activeRevision: nextRevision, published: revision.definition, updatedAt: now };
    await store.updateRule(updated);
    await store.createRuleRevision({ ruleId: rule.id, revision: nextRevision, definition: revision.definition, publishedAt: now });
    return { rule: updated };
  });

  app.post<{ Params: { id: string; ruleId: string } }>("/v1/management/connections/:id/rules/:ruleId/disable", async request => {
    const connection = await ownedConnection(store, request.params.id, accountId(request));
    const rule = await store.getRule(request.params.ruleId);
    if (!rule || rule.connectionId !== connection.id) throw new ApiError(404, "rule_not_found", "Rule not found.");
    const updated = { ...rule, enabled: false, updatedAt: new Date().toISOString() };
    await store.updateRule(updated);
    return { rule: updated };
  });

  app.delete<{ Params: { id: string; ruleId: string } }>("/v1/management/connections/:id/rules/:ruleId", async (request, reply) => {
    const connection = await ownedConnection(store, request.params.id, accountId(request));
    const rule = await store.getRule(request.params.ruleId);
    if (!rule || rule.connectionId !== connection.id) throw new ApiError(404, "rule_not_found", "Rule not found.");
    await store.deleteRule(rule.id);
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>("/v1/management/connections/:id/rule-executions", async request => {
    const connection = await ownedConnection(store, request.params.id, accountId(request));
    return { executions: await store.listRuleExecutions(connection.id) };
  });

  app.get<{ Params: { subscriptionId: string }; Querystring: { cursor?: string; limit?: string } }>("/v1/poll/subscriptions/:subscriptionId/events", async request => {
    const subscription = await store.getPollSubscription(request.params.subscriptionId);
    const token = bearer(request);
    if (!subscription || subscription.revokedAt || !token || !constantTimeEqual(hashToken(token), subscription.tokenHash)) {
      throw new ApiError(401, "credential_invalid", "Poll credential is invalid.");
    }
    const connection = await store.getConnection(subscription.connectionId);
    if (!connection || connection.paused) throw new ApiError(404, "connection_not_found", "Connection not found.");
    const updated = { ...subscription, lastUsedAt: new Date().toISOString() };
    await store.updatePollSubscription(updated);
    const limit = Math.min(Math.max(Number(request.query.limit ?? 50), 1), 100);
    const query: EventQuery = { limit, pendingForSubscriptionId: subscription.id };
    const cursor = decodeCursor(request.query.cursor);
    if (cursor) query.cursor = cursor;
    const page = await store.listEvents(connection.id, query);
    return { ...page, events: page.events.map(event => eventJson(event)) };
  });

  app.post<{ Params: { subscriptionId: string } }>("/v1/poll/subscriptions/:subscriptionId/events/acknowledge", async request => {
    const subscription = await store.getPollSubscription(request.params.subscriptionId);
    const token = bearer(request);
    if (!subscription || subscription.revokedAt || !token || !constantTimeEqual(hashToken(token), subscription.tokenHash)) {
      throw new ApiError(401, "credential_invalid", "Poll credential is invalid.");
    }
    const eventIds = stringArray(body(request).eventIds, 100);
    return await store.acknowledgeEvents(subscription.id, eventIds, new Date().toISOString());
  });

  const ingestHandler = async (request: FastifyRequest<{ Params: { publicId: string } }>, reply: FastifyReply) => {
    const connection = await store.getConnectionByPublicId(request.params.publicId);
    if (!connection || connection.paused) throw new ApiError(404, "connection_not_found", "Connection not found.");
    const limit = await store.takeRateLimit(`ingest:${connection.id}`, RUNTIME_LIMITS.ingestPerMinute, 60_000);
    if (!limit.allowed) throw new ApiError(429, "rate_limited", "Ingest rate limit reached.", { retryAfterSeconds: Math.ceil(limit.retryAfterMs / 1000) });
    const raw = (request as FastifyRequest & { rawBody?: Buffer }).rawBody;
    const timestamp = request.headers["x-signature-timestamp"];
    const signature = request.headers["x-signature-ed25519"];
    if (!raw || typeof timestamp !== "string" || typeof signature !== "string" || !verifyErlcSignature({
      rawBody: raw, timestamp, signature, publicKeySpkiBase64: config.erlcPublicKeySpkiBase64,
      maxClockSkewSeconds: config.webhookMaxClockSkewSeconds
    })) {
      const invalid = await store.takeRateLimit(`invalid-signature:${request.ip}:${connection.publicId}`,
        RUNTIME_LIMITS.invalidSignaturesPerTenMinutes, 10 * 60_000);
      if (!invalid.allowed) throw new ApiError(429, "rate_limited", "Too many invalid webhook signatures.", {
        retryAfterSeconds: Math.ceil(invalid.retryAfterMs / 1000)
      });
      throw new ApiError(401, "signature_invalid", "Webhook signature is invalid.");
    }
    const headers = Object.fromEntries(Object.entries(request.headers)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([key, value]) => [key.toLowerCase(), value]));
    const events = normalizeWebhookEvents({ connectionId: connection.id, rawBody: raw, payload: request.body, headers });
    const savedEvents: GatewayEvent[] = [];
    let inserted = 0;
    for (const [index, event] of events.entries()) {
      const matchingRules = await ruleEngine.matchingRules(event);
      const deliveries = await planEventDeliveries(store, event, matchingRules.length > 0,
        new Date().toISOString(), { rawBatchPrimary: index === 0 });
      const saved = await store.saveEventWithJobs(event, deliveries.jobs, ruleEngine.planJobs(event, matchingRules));
      savedEvents.push(saved.event);
      if (saved.inserted) {
        inserted += 1;
      }
    }
    return reply.code(202).send({
      accepted: true,
      eventId: savedEvents[0]?.id,
      eventIds: savedEvents.map(event => event.id),
      duplicate: inserted === 0
    });
  };
  app.post<{ Params: { publicId: string } }>("/v1/ingest/:publicId", ingestHandler);
  app.post<{ Params: { publicId: string } }>("/webhook/:publicId", ingestHandler);
  app.post<{ Params: { publicId: string } }>("/webhook/erlc/:publicId", ingestHandler);

  app.get<{ Params: { publicId: string } }>("/webhook/:publicId", async request => {
    const connection = await store.getConnectionByPublicId(request.params.publicId);
    if (!connection || connection.paused) throw new ApiError(404, "connection_not_found", "Connection not found.");
    return { ok: true, mode: connection.legacyPreset ?? "poll", webhookId: connection.publicId };
  });

  app.get<{ Params: { publicId: string }; Querystring: { limit?: string } }>("/webhook/:publicId/events", async request => {
    const connection = await store.getConnectionByPublicId(request.params.publicId);
    if (!connection || connection.paused) throw new ApiError(404, "connection_not_found", "Connection not found.");
    const subscription = (await store.listPollSubscriptions(connection.id))[0];
    if (!subscription) return { count: 0, events: [] };
    const limit = Math.min(Math.max(Number(request.query.limit ?? 50), 1), 100);
    const page = await store.listEvents(connection.id, { limit, pendingForSubscriptionId: subscription.id });
    if (page.events.length) await store.acknowledgeEvents(subscription.id, page.events.map(event => event.id), new Date().toISOString());
    return { count: page.events.length, events: page.events.map(legacyEasyEvent), hasMore: page.hasMore };
  });

  app.addHook("onClose", async () => { worker.stop(); ruleWorker.stop(); maintenanceWorker.stop(); await store.close(); });
  return { app, worker, ruleEngine, ruleWorker, maintenanceWorker };
}
