import http from "node:http";
import https from "node:https";
import type { GatewayConfig } from "./config.js";
import { RUNTIME_LIMITS } from "./limits.js";
import { decryptSecret, randomId, signProxyBody, validateDestinationUrl } from "./security.js";
import type { GatewayStore } from "./store.js";
import type { DeliveryJob, ForwardDestination, GatewayEvent } from "./types.js";

function publicEvent(event: GatewayEvent) {
  return {
    id: event.id,
    connectionId: event.connectionId,
    type: event.type,
    ...(event.originalType ? { originalType: event.originalType } : {}),
    occurredAt: event.occurredAt,
    receivedAt: event.receivedAt,
    ...(event.serverId ? { serverId: event.serverId } : {}),
    data: event.data,
    synthetic: event.synthetic
  };
}

export function legacyEasyEvent(event: GatewayEvent) {
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(event.rawBody.toString("utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
  } catch { /* Imported or malformed historical data falls back to normalized fields. */ }
  const first = Array.isArray(payload.events) && payload.events[0] && typeof payload.events[0] === "object"
    ? payload.events[0] as Record<string, unknown>
    : payload;
  const nested = first.data && typeof first.data === "object" && !Array.isArray(first.data)
    ? first.data as Record<string, unknown>
    : undefined;
  const flattened = nested ?? Object.fromEntries(Object.entries(first).filter(([key]) =>
    !["event", "type", "origin", "userId", "userID", "timestamp", "server", "data"].includes(key)));
  const data = Object.keys(flattened).length ? flattened : event.data;
  const server = payload.server ?? first.server ?? event.data.server;
  return {
    event: first.event ?? first.type ?? event.originalType ?? event.type,
    userId: first.origin ?? first.userId ?? first.userID ?? event.data.userId ?? "",
    timestamp: first.timestamp ?? event.occurredAt,
    ...data,
    ...(server !== undefined ? { server } : event.serverId ? { server: { id: event.serverId } } : {})
  };
}

function commandName(event: GatewayEvent) {
  return event.type === "CustomCommand" && typeof event.data.command === "string"
    ? event.data.command.toLowerCase()
    : "";
}

export function destinationMatchesEvent(destination: ForwardDestination, event: GatewayEvent, hostedMatched: boolean) {
  const filter = destination.filter;
  if (filter.eventTypes.length && !filter.eventTypes.includes("*") && !filter.eventTypes.includes(event.type)) return false;
  if (event.type !== "CustomCommand") return true;
  const command = commandName(event);
  if (filter.includedCommands.length && !filter.includedCommands.includes(command)) return false;
  if (filter.excludedCommands.includes(command)) return false;
  if (filter.commandPolicy === "unmatchedHosted" && hostedMatched) return false;
  return true;
}

export async function enqueueEventDeliveries(
  store: GatewayStore,
  event: GatewayEvent,
  hostedMatched: boolean,
  now = new Date().toISOString(),
  options: { rawBatchPrimary?: boolean } = {}
) {
  const destinations = await store.listDestinations(event.connectionId);
  const enqueued: string[] = [];
  const skipped: Array<{ destinationId: string; reason: string }> = [];
  for (const destination of destinations) {
    if (options.rawBatchPrimary === false && (destination.type === "rawMirror" || destination.type === "legacyEasy")) {
      skipped.push({ destinationId: destination.id, reason: "raw_batch_already_forwarded" });
      continue;
    }
    if (!destination.enabled || destination.healthState === "paused" || destination.healthState === "blocked") {
      skipped.push({ destinationId: destination.id, reason: "destination_inactive" });
      continue;
    }
    if (!destinationMatchesEvent(destination, event, hostedMatched)) {
      skipped.push({ destinationId: destination.id, reason: "filtered" });
      continue;
    }
    if (await store.countQueuedDeliveries(destination.id) >= RUNTIME_LIMITS.queuedPerDestination) {
      await store.updateDestination({ ...destination, healthState: "degraded", updatedAt: now });
      skipped.push({ destinationId: destination.id, reason: "queue_full" });
      continue;
    }
    const id = randomId("del");
    const inserted = await store.enqueueDelivery({
      id, destinationId: destination.id, eventId: event.id, attempt: 0,
      state: "pending", availableAt: now, createdAt: now
    });
    if (inserted) enqueued.push(id);
    else skipped.push({ destinationId: destination.id, reason: "duplicate" });
  }
  return { enqueued, skipped };
}

export interface DestinationResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export async function sendPinnedRequest(options: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Buffer;
  timeoutMs: number;
}): Promise<DestinationResponse> {
  const validated = await validateDestinationUrl(options.url);
  const target = validated.url;
  const address = validated.addresses[0]!;
  const transport = target.protocol === "https:" ? https : http;
  return await new Promise<DestinationResponse>((resolve, reject) => {
    const request = transport.request({
      protocol: target.protocol,
      hostname: address,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      method: options.method,
      path: `${target.pathname}${target.search}`,
      headers: { ...options.headers, host: target.host },
      ...(target.protocol === "https:" ? { servername: target.hostname } : {}),
      timeout: options.timeoutMs
    }, response => {
      const chunks: Buffer[] = [];
      let length = 0;
      response.on("data", (chunk: Buffer) => {
        if (length >= RUNTIME_LIMITS.maxResponseExcerptBytes) return;
        const value = Buffer.from(chunk);
        chunks.push(value.subarray(0, RUNTIME_LIMITS.maxResponseExcerptBytes - length));
        length += value.length;
      });
      response.on("end", () => resolve({
        statusCode: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).subarray(0, RUNTIME_LIMITS.maxResponseExcerptBytes)
      }));
    });
    request.once("timeout", () => request.destroy(Object.assign(new Error("Destination timed out"), { code: "destination_timeout" })));
    request.once("error", reject);
    request.end(options.body);
  });
}

export interface ForwardingWorkerOptions {
  store: GatewayStore;
  config: GatewayConfig;
  request?: typeof sendPinnedRequest;
  now?: () => number;
  random?: () => number;
}

export class ForwardingWorker {
  readonly #store: GatewayStore;
  readonly #config: GatewayConfig;
  readonly #request: typeof sendPinnedRequest;
  readonly #now: () => number;
  readonly #random: () => number;
  #timer: NodeJS.Timeout | undefined;
  #running = false;

  constructor(options: ForwardingWorkerOptions) {
    this.#store = options.store;
    this.#config = options.config;
    this.#request = options.request ?? sendPinnedRequest;
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
  }

  start() {
    if (this.#timer) return;
    this.#timer = setInterval(() => { void this.runOnce(); }, this.#config.workerPollMs);
    this.#timer.unref();
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async runOnce() {
    if (this.#running) return 0;
    this.#running = true;
    try {
      const jobs = await this.#store.claimDeliveries(10, new Date(this.#now()).toISOString());
      await Promise.all(jobs.map(job => this.#process(job)));
      return jobs.length;
    } finally {
      this.#running = false;
    }
  }

  async #process(job: DeliveryJob) {
    const destination = await this.#store.getDestination(job.destinationId);
    const event = await this.#store.getEvent(job.eventId);
    if (!destination || !event || !destination.enabled || ["paused", "blocked"].includes(destination.healthState)) {
      await this.#store.updateDelivery({ ...job, state: "cancelled", lastErrorCode: "destination_inactive" });
      return;
    }
    const connection = await this.#store.getConnection(destination.connectionId);
    if (!connection || connection.paused) {
      await this.#store.updateDelivery({ ...job, state: "cancelled", lastErrorCode: "connection_inactive" });
      return;
    }
    const budgets = await Promise.all([
      this.#store.takeRateLimit(`forward:destination:${destination.id}`, RUNTIME_LIMITS.destinationPerMinute, 60_000, this.#now()),
      this.#store.takeRateLimit(`forward:connection:${connection.id}`, RUNTIME_LIMITS.connectionPerMinute, 60_000, this.#now()),
      this.#store.takeRateLimit(`forward:account:${connection.accountId}`, RUNTIME_LIMITS.accountPerMinute, 60_000, this.#now())
    ]);
    const blocked = budgets.find(value => !value.allowed);
    if (blocked) {
      await this.#store.updateDelivery({
        ...job, state: "pending", availableAt: new Date(this.#now() + blocked.retryAfterMs).toISOString(),
        lastErrorCode: "rate_limited"
      });
      return;
    }

    const timestamp = String(Math.floor(this.#now() / 1000));
    const body = destination.type === "rawMirror"
      ? event.rawBody
      : Buffer.from(JSON.stringify(destination.type === "legacyEasy" ? legacyEasyEvent(event) : publicEvent(event)), "utf8");
    const headers: Record<string, string> = destination.type === "rawMirror"
      ? {
          "content-type": "application/json",
          ...(event.originalHeaders["x-signature-timestamp"] ? { "x-signature-timestamp": event.originalHeaders["x-signature-timestamp"] } : {}),
          ...(event.originalHeaders["x-signature-ed25519"] ? { "x-signature-ed25519": event.originalHeaders["x-signature-ed25519"] } : {}),
          "x-liberty-event-id": event.id,
          "x-liberty-delivery-id": job.id,
          via: "LibertyTools"
        }
      : destination.type === "legacyEasy"
        ? {
            "content-type": "application/json",
            "x-liberty-event-id": event.id,
            "x-liberty-delivery-id": job.id,
            via: "LibertyTools"
          }
        : {
          "content-type": "application/json",
          "x-liberty-event-id": event.id,
          "x-liberty-delivery-id": job.id,
          "x-liberty-timestamp": timestamp,
          ...(destination.encryptedSecret
            ? { "x-liberty-signature": `v1=${signProxyBody(decryptSecret(destination.encryptedSecret, this.#config.encryptionKey), timestamp, body)}` }
            : {})
        };
    const started = this.#now();
    let statusCode: number | undefined;
    let responseExcerpt: string | undefined;
    let errorCode: string | undefined;
    let retryAfterMs: number | undefined;
    try {
      const response = await this.#request({
        url: destination.url, method: "POST", headers, body, timeoutMs: this.#config.forwardTimeoutMs
      });
      statusCode = response.statusCode;
      responseExcerpt = response.body.toString("utf8");
      if (statusCode >= 200 && statusCode < 300) {
        const now = new Date(this.#now()).toISOString();
        await this.#store.updateDestination({
          ...destination, healthState: "active", consecutiveFailures: 0,
          successfulDeliveries: destination.successfulDeliveries + 1, updatedAt: now
        });
        await this.#store.updateDelivery({ ...job, attempt: job.attempt + 1, state: "succeeded", availableAt: now });
        await this.#store.recordDeliveryAttempt({
          id: randomId("att"), deliveryId: job.id, attemptedAt: now, statusCode,
          latencyMs: this.#now() - started, result: "succeeded", ...(responseExcerpt ? { responseExcerpt } : {})
        });
        return;
      }
      errorCode = `http_${statusCode}`;
      const retryAfter = response.headers["retry-after"];
      if (statusCode === 429 && typeof retryAfter === "string") {
        const seconds = Number(retryAfter);
        if (Number.isFinite(seconds)) retryAfterMs = Math.min(seconds * 1000, this.#config.forwardRetryWindowMs);
      }
    } catch (error) {
      errorCode = typeof error === "object" && error && "code" in error ? String(error.code) : "destination_unreachable";
    }

    const failures = destination.consecutiveFailures + 1;
    const threshold = destination.healthState === "probation"
      ? RUNTIME_LIMITS.probationAttempts
      : RUNTIME_LIMITS.activeConsecutiveFailures;
    const shouldPause = failures >= threshold;
    const attempt = job.attempt + 1;
    const retryableStatus = statusCode === undefined || [408, 425, 429].includes(statusCode) || statusCode >= 500;
    const withinWindow = this.#now() - new Date(job.createdAt).getTime() < this.#config.forwardRetryWindowMs;
    const shouldRetry = !shouldPause && retryableStatus && attempt < this.#config.forwardMaxAttempts && withinWindow;
    const delay = retryAfterMs ?? Math.min(30_000, (2 ** Math.max(0, attempt - 1)) * 500 + Math.floor(this.#random() * 250));
    const now = new Date(this.#now()).toISOString();
    await this.#store.updateDestination({
      ...destination,
      healthState: shouldPause ? "paused" : destination.healthState === "probation" ? "probation" : "degraded",
      enabled: !shouldPause,
      consecutiveFailures: failures, updatedAt: now
    });
    await this.#store.updateDelivery({
      ...job, attempt, state: shouldRetry ? "pending" : "failed",
      availableAt: shouldRetry ? new Date(this.#now() + delay).toISOString() : now,
      ...(errorCode ? { lastErrorCode: errorCode } : {})
    });
    await this.#store.recordDeliveryAttempt({
      id: randomId("att"), deliveryId: job.id, attemptedAt: now,
      ...(statusCode !== undefined ? { statusCode } : {}), latencyMs: this.#now() - started,
      result: shouldRetry ? "retrying" : "failed",
      ...(responseExcerpt ? { responseExcerpt } : {}), ...(errorCode ? { errorCode } : {})
    });
  }
}
