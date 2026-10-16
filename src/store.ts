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

export interface EventQuery {
  cursor?: { receivedAt: string; id: string };
  limit: number;
  type?: string;
  pendingForSubscriptionId?: string;
}

export interface GatewayStore {
  init(): Promise<void>;
  close(): Promise<void>;
  createConnection(connection: Connection): Promise<void>;
  listConnections(accountId: string): Promise<Connection[]>;
  getConnection(id: string): Promise<Connection | undefined>;
  getConnectionByPublicId(publicId: string): Promise<Connection | undefined>;
  updateConnection(connection: Connection): Promise<void>;
  deleteConnection(id: string, deletedAt: string): Promise<void>;

  createPollSubscription(subscription: PollSubscription): Promise<void>;
  listPollSubscriptions(connectionId: string): Promise<PollSubscription[]>;
  getPollSubscription(id: string): Promise<PollSubscription | undefined>;
  updatePollSubscription(subscription: PollSubscription): Promise<void>;
  deletePollSubscription(id: string): Promise<void>;

  createDestination(destination: ForwardDestination): Promise<void>;
  listDestinations(connectionId: string): Promise<ForwardDestination[]>;
  getDestination(id: string): Promise<ForwardDestination | undefined>;
  updateDestination(destination: ForwardDestination): Promise<void>;
  deleteDestination(id: string): Promise<void>;

  saveEvent(event: GatewayEvent): Promise<{ inserted: boolean; event: GatewayEvent }>;
  getEvent(id: string): Promise<GatewayEvent | undefined>;
  listEvents(connectionId: string, query: EventQuery): Promise<EventPage>;
  acknowledgeEvents(subscriptionId: string, eventIds: string[], acknowledgedAt: string): Promise<{
    acknowledged: string[];
    alreadyAcknowledged: string[];
    unknown: string[];
  }>;

  enqueueDelivery(job: DeliveryJob): Promise<boolean>;
  countQueuedDeliveries(destinationId: string): Promise<number>;
  claimDeliveries(limit: number, now: string): Promise<DeliveryJob[]>;
  updateDelivery(job: DeliveryJob): Promise<void>;
  recordDeliveryAttempt(attempt: DeliveryAttempt): Promise<void>;

  createRule(rule: Rule): Promise<void>;
  listRules(connectionId: string): Promise<Rule[]>;
  getRule(id: string): Promise<Rule | undefined>;
  updateRule(rule: Rule): Promise<void>;
  deleteRule(id: string): Promise<void>;
  recordRuleExecution(execution: RuleExecution): Promise<void>;
  listRuleExecutions(connectionId: string): Promise<RuleExecution[]>;

  takeRateLimit(key: string, limit: number, windowMs: number, now?: number): Promise<{
    allowed: boolean;
    remaining: number;
    retryAfterMs: number;
  }>;
  takeCooldown(key: string, durationMs: number, now?: number): Promise<{ allowed: boolean; retryAfterMs: number }>;
}
