import { encodeCursor } from "./normalization.js";
import { FixedWindowLimiter } from "./limits.js";
import { randomId } from "./security.js";
import type { EventQuery, GatewayStore } from "./store.js";
import type {
  AuditEntry,
  Connection,
  DeliveryAttempt,
  DeliveryJob,
  DeliveryRecord,
  ForwardDestination,
  GatewayEvent,
  PollSubscription,
  ProviderRequestSample,
  Rule,
  RuleRevision,
  RuleExecution,
  RuleJob
} from "./types.js";

function eventMatchesSubscription(event: GatewayEvent, subscription: PollSubscription) {
  if (subscription.eventTypes.length && !subscription.eventTypes.includes("*") && !subscription.eventTypes.includes(event.type)) {
    return false;
  }
  if (event.type !== "CustomCommand") return true;
  const command = typeof event.data.command === "string" ? event.data.command.toLowerCase() : "";
  if (subscription.includedCommands.length && !subscription.includedCommands.includes(command)) return false;
  return !subscription.excludedCommands.includes(command);
}

export class MemoryGatewayStore implements GatewayStore {
  readonly connections = new Map<string, Connection>();
  readonly subscriptions = new Map<string, PollSubscription>();
  readonly destinations = new Map<string, ForwardDestination>();
  readonly events = new Map<string, GatewayEvent>();
  readonly eventByDedupe = new Map<string, string>();
  readonly acknowledgements = new Set<string>();
  readonly deliveries = new Map<string, DeliveryJob>();
  readonly deliveryAttempts: DeliveryAttempt[] = [];
  readonly rules = new Map<string, Rule>();
  readonly ruleRevisions = new Map<string, RuleRevision>();
  readonly ruleExecutions: RuleExecution[] = [];
  readonly ruleJobs = new Map<string, RuleJob>();
  readonly limiter = new FixedWindowLimiter();
  readonly cooldowns = new Map<string, number>();
  readonly auditEntries: AuditEntry[] = [];
  readonly providerRequests: ProviderRequestSample[] = [];

  async init() {}
  async close() {}
  async recordProviderRequest(sample: ProviderRequestSample) { this.providerRequests.push(sample); }

  async createConnection(connection: Connection) { this.connections.set(connection.id, connection); }
  async listConnections(accountId: string) {
    return [...this.connections.values()].filter(value => value.accountId === accountId && !value.deletedAt);
  }
  async getConnection(id: string) {
    const value = this.connections.get(id);
    return value && !value.deletedAt ? value : undefined;
  }
  async getConnectionByPublicId(publicId: string) {
    return [...this.connections.values()].find(value => value.publicId === publicId && !value.deletedAt);
  }
  async updateConnection(connection: Connection) { this.connections.set(connection.id, connection); }
  async deleteConnection(id: string, deletedAt: string) {
    const connection = this.connections.get(id);
    if (connection) this.connections.set(id, { ...connection, deletedAt, paused: true, updatedAt: deletedAt });
  }

  async createPollSubscription(subscription: PollSubscription) { this.subscriptions.set(subscription.id, subscription); }
  async listPollSubscriptions(connectionId: string) {
    return [...this.subscriptions.values()].filter(value => value.connectionId === connectionId);
  }
  async getPollSubscription(id: string) { return this.subscriptions.get(id); }
  async updatePollSubscription(subscription: PollSubscription) { this.subscriptions.set(subscription.id, subscription); }
  async deletePollSubscription(id: string) { this.subscriptions.delete(id); }

  async createDestination(destination: ForwardDestination) { this.destinations.set(destination.id, destination); }
  async listDestinations(connectionId: string) {
    return [...this.destinations.values()].filter(value => value.connectionId === connectionId);
  }
  async getDestination(id: string) { return this.destinations.get(id); }
  async updateDestination(destination: ForwardDestination) { this.destinations.set(destination.id, destination); }
  async deleteDestination(id: string) { this.destinations.delete(id); }

  async saveEvent(event: GatewayEvent) {
    const existingId = this.eventByDedupe.get(event.dedupeKey);
    const existing = existingId ? this.events.get(existingId) : undefined;
    if (existing) return { inserted: false, event: existing };
    this.events.set(event.id, event);
    this.eventByDedupe.set(event.dedupeKey, event.id);
    return { inserted: true, event };
  }
  async saveEventWithJobs(event: GatewayEvent, deliveries: DeliveryJob[], rules: RuleJob[]) {
    const saved = await this.saveEvent(event);
    if (saved.inserted) {
      for (const job of deliveries) await this.enqueueDelivery(job);
      for (const job of rules) await this.enqueueRuleJob(job);
    }
    return saved;
  }
  async getEvent(id: string) { return this.events.get(id); }
  async listEvents(connectionId: string, query: EventQuery) {
    const subscription = query.pendingForSubscriptionId
      ? this.subscriptions.get(query.pendingForSubscriptionId)
      : undefined;
    let values = [...this.events.values()]
      .filter(event => event.connectionId === connectionId)
      .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.id.localeCompare(b.id));
    if (query.cursor) {
      values = values.filter(event => event.receivedAt > query.cursor!.receivedAt ||
        (event.receivedAt === query.cursor!.receivedAt && event.id > query.cursor!.id));
    }
    if (query.type) values = values.filter(event => event.type === query.type);
    if (subscription) {
      values = values.filter(event => eventMatchesSubscription(event, subscription) &&
        !this.acknowledgements.has(`${subscription.id}:${event.id}`));
    }
    const pendingCount = subscription ? values.length : 0;
    const pageValues = values.slice(0, query.limit);
    return {
      events: pageValues,
      nextCursor: pageValues.length ? encodeCursor(pageValues[pageValues.length - 1]!) : null,
      hasMore: values.length > query.limit,
      pendingCount
    };
  }
  async acknowledgeEvents(subscriptionId: string, eventIds: string[], _acknowledgedAt: string) {
    const subscription = this.subscriptions.get(subscriptionId);
    const acknowledged: string[] = [];
    const alreadyAcknowledged: string[] = [];
    const unknown: string[] = [];
    for (const eventId of eventIds) {
      const event = this.events.get(eventId);
      if (!subscription || !event || event.connectionId !== subscription.connectionId ||
        !eventMatchesSubscription(event, subscription)) {
        unknown.push(eventId);
        continue;
      }
      const key = `${subscriptionId}:${eventId}`;
      if (this.acknowledgements.has(key)) alreadyAcknowledged.push(eventId);
      else {
        this.acknowledgements.add(key);
        acknowledged.push(eventId);
      }
    }
    return { acknowledged, alreadyAcknowledged, unknown };
  }

  async enqueueDelivery(job: DeliveryJob) {
    const duplicate = [...this.deliveries.values()].some(value =>
      value.destinationId === job.destinationId && value.eventId === job.eventId);
    if (duplicate) return false;
    this.deliveries.set(job.id, job);
    return true;
  }
  async countQueuedDeliveries(destinationId: string) {
    return [...this.deliveries.values()].filter(value =>
      value.destinationId === destinationId && (value.state === "pending" || value.state === "running")).length;
  }
  async claimDeliveries(limit: number, now: string): Promise<DeliveryJob[]> {
    const jobs = [...this.deliveries.values()]
      .filter(value => (value.state === "pending" || value.state === "running") && value.availableAt <= now)
      .sort((a, b) => a.availableAt.localeCompare(b.availableAt))
      .slice(0, limit);
    const leaseUntil = new Date(Date.parse(now) + 5 * 60_000).toISOString();
    for (const job of jobs) this.deliveries.set(job.id, { ...job, state: "running", availableAt: leaseUntil });
    return jobs.map(job => ({ ...job, state: "running" as const, availableAt: leaseUntil }));
  }
  async updateDelivery(job: DeliveryJob) { this.deliveries.set(job.id, job); }
  async recordDeliveryAttempt(attempt: DeliveryAttempt) { this.deliveryAttempts.push(attempt); }
  async getDelivery(id: string): Promise<DeliveryRecord | undefined> {
    const job = this.deliveries.get(id);
    if (!job) return undefined;
    const destination = this.destinations.get(job.destinationId);
    const event = this.events.get(job.eventId);
    if (!destination || !event) return undefined;
    return { ...job, connectionId: destination.connectionId, destinationName: destination.name,
      destinationType: destination.type, eventType: event.type,
      attempts: this.deliveryAttempts.filter(value => value.deliveryId === id) };
  }
  async listDeliveries(connectionId: string, limit: number) {
    const values: DeliveryRecord[] = [];
    for (const job of [...this.deliveries.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
      const record = await this.getDelivery(job.id);
      if (record?.connectionId === connectionId) values.push(record);
      if (values.length >= limit) break;
    }
    return values;
  }

  async createRule(rule: Rule) { this.rules.set(rule.id, rule); }
  async listRules(connectionId: string) {
    return [...this.rules.values()].filter(value => value.connectionId === connectionId);
  }
  async getRule(id: string) { return this.rules.get(id); }
  async updateRule(rule: Rule) { this.rules.set(rule.id, rule); }
  async deleteRule(id: string) { this.rules.delete(id); }
  async createRuleRevision(revision: RuleRevision) { this.ruleRevisions.set(`${revision.ruleId}:${revision.revision}`, revision); }
  async listRuleRevisions(ruleId: string) {
    return [...this.ruleRevisions.values()].filter(value => value.ruleId === ruleId).sort((a, b) => b.revision - a.revision);
  }
  async getRuleRevision(ruleId: string, revision: number) { return this.ruleRevisions.get(`${ruleId}:${revision}`); }
  async recordRuleExecution(execution: RuleExecution) { this.ruleExecutions.push(execution); }
  async listRuleExecutions(connectionId: string) {
    const ruleIds = new Set((await this.listRules(connectionId)).map(rule => rule.id));
    return this.ruleExecutions.filter(value => ruleIds.has(value.ruleId));
  }
  async enqueueRuleJob(job: RuleJob) {
    if ([...this.ruleJobs.values()].some(value => value.ruleId === job.ruleId && value.eventId === job.eventId)) return false;
    this.ruleJobs.set(job.id, job); return true;
  }
  async claimRuleJobs(limit: number, now: string) {
    for (const job of this.ruleJobs.values()) {
      if (job.state !== "running" || job.availableAt > now) continue;
      this.ruleJobs.set(job.id, { ...job, state: "failed", lastErrorCode: "worker_interrupted" });
      if (!this.ruleExecutions.some(value => value.ruleId === job.ruleId && value.eventId === job.eventId)) {
        this.ruleExecutions.push({ id: randomId("exe"), ruleId: job.ruleId, eventId: job.eventId,
          status: "uncertain", detail: { code: "worker_interrupted" }, createdAt: now, completedAt: now });
      }
    }
    const jobs = [...this.ruleJobs.values()].filter(value => value.state === "pending" && value.availableAt <= now)
      .sort((a, b) => a.availableAt.localeCompare(b.availableAt)).slice(0, limit);
    const leaseUntil = new Date(Date.parse(now) + 5 * 60_000).toISOString();
    for (const job of jobs) this.ruleJobs.set(job.id, { ...job, state: "running", availableAt: leaseUntil });
    return jobs.map(job => ({ ...job, state: "running" as const, availableAt: leaseUntil }));
  }
  async updateRuleJob(job: RuleJob) { this.ruleJobs.set(job.id, job); }

  async takeRateLimit(key: string, limit: number, windowMs: number, now?: number) {
    return this.limiter.take(key, limit, windowMs, now);
  }
  async takeCooldown(key: string, durationMs: number, now = Date.now()) {
    const availableAt = this.cooldowns.get(key) ?? 0;
    if (availableAt > now) return { allowed: false, retryAfterMs: availableAt - now };
    this.cooldowns.set(key, now + durationMs);
    return { allowed: true, retryAfterMs: 0 };
  }
  async remainingCooldown(key: string, now = Date.now()) {
    return Math.max(0, (this.cooldowns.get(key) ?? 0) - now);
  }
  async setCooldown(key: string, durationMs: number, now = Date.now()) {
    this.cooldowns.set(key, Math.max(this.cooldowns.get(key) ?? 0, now + durationMs));
  }
  async recordAudit(entry: AuditEntry) { this.auditEntries.push(entry); }
  async listAudit(accountId: string, connectionId: string | undefined, limit: number) {
    return this.auditEntries.filter(value => value.accountId === accountId && (!connectionId || value.connectionId === connectionId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }
  async cleanup(beforeEvents: string, beforeAudit: string) {
    let events = 0;
    for (const [id, event] of this.events) if (event.receivedAt < beforeEvents) { this.events.delete(id); this.eventByDedupe.delete(event.dedupeKey); events += 1; }
    const before = this.auditEntries.length;
    for (let index = this.auditEntries.length - 1; index >= 0; index -= 1) if (this.auditEntries[index]!.createdAt < beforeAudit) this.auditEntries.splice(index, 1);
    return { events, audit: before - this.auditEntries.length };
  }
}

export { eventMatchesSubscription };
