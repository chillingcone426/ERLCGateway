export type LegacyPreset = "poll" | "proxy" | "easy";
export type DestinationType = "signedProxy" | "rawMirror" | "legacyEasy";
export type DestinationHealth = "probation" | "active" | "degraded" | "paused" | "blocked";
export type CommandPolicy = "all" | "exclude" | "unmatchedHosted";

export interface ProviderRequestSample {
  operation: "server" | "players" | "command";
  statusCode?: number;
  latencyMs: number;
  rateLimitBucket?: string;
  rateLimitLimit?: number;
  rateLimitRemaining?: number;
  recordedAt: string;
}

export interface Connection {
  id: string;
  accountId: string;
  name: string;
  publicId: string;
  paused: boolean;
  legacyPreset?: LegacyPreset;
  serverId?: string;
  serverName?: string;
  encryptedServerKey?: string;
  serverKeyFingerprint?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface PollSubscription {
  id: string;
  connectionId: string;
  name: string;
  tokenHash: string;
  tokenPrefix: string;
  eventTypes: string[];
  includedCommands: string[];
  excludedCommands: string[];
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface DestinationFilter {
  eventTypes: string[];
  commandPolicy: CommandPolicy;
  includedCommands: string[];
  excludedCommands: string[];
}

export interface ForwardDestination {
  id: string;
  connectionId: string;
  name: string;
  type: DestinationType;
  url: string;
  providerPreset?: string;
  encryptedSecret?: string;
  secretPrefix?: string;
  healthState: DestinationHealth;
  enabled: boolean;
  transportSecurity: "encrypted" | "unencrypted";
  consecutiveFailures: number;
  successfulDeliveries: number;
  filter: DestinationFilter;
  createdAt: string;
  updatedAt: string;
}

export interface GatewayEvent {
  id: string;
  connectionId: string;
  type: string;
  originalType?: string;
  occurredAt: string;
  receivedAt: string;
  serverId?: string;
  data: Record<string, unknown>;
  rawBody: Buffer;
  originalHeaders: Record<string, string>;
  synthetic: boolean;
  dedupeKey: string;
}

export interface EventPage {
  events: GatewayEvent[];
  nextCursor: string | null;
  hasMore: boolean;
  pendingCount: number;
}

export interface DeliveryJob {
  id: string;
  destinationId: string;
  eventId: string;
  attempt: number;
  state: "pending" | "running" | "succeeded" | "failed" | "cancelled";
  availableAt: string;
  createdAt: string;
  lastErrorCode?: string;
}

export interface DeliveryAttempt {
  id: string;
  deliveryId: string;
  attemptedAt: string;
  statusCode?: number;
  latencyMs: number;
  result: "succeeded" | "retrying" | "failed";
  responseExcerpt?: string;
  errorCode?: string;
}

export interface DeliveryRecord extends DeliveryJob {
  connectionId: string;
  destinationName: string;
  destinationType: DestinationType;
  eventType: string;
  attempts: DeliveryAttempt[];
}

export type RuleTrigger =
  | { type: "customCommand"; command: string }
  | { type: "event"; eventType: string };

export type RuleCondition =
  | { field: "command.argument"; operator: "exists" }
  | { field: "command.argument"; operator: "equals" | "contains"; value: string }
  | { field: "player.id"; operator: "equals"; value: string };

export type RuleAction =
  | { type: "privateReply"; message: string }
  | { type: "announce"; message: string };

export interface RuleDefinition {
  trigger: RuleTrigger;
  conditions: RuleCondition[];
  actions: RuleAction[];
  cooldown?: { durationMs: number; scope: "player" | "command" | "server" };
}

export interface Rule {
  id: string;
  connectionId: string;
  name: string;
  enabled: boolean;
  draftVersion: number;
  draft: RuleDefinition;
  activeRevision?: number;
  published?: RuleDefinition;
  createdAt: string;
  updatedAt: string;
}

export interface RuleRevision {
  ruleId: string;
  revision: number;
  definition: RuleDefinition;
  publishedAt: string;
}

export interface RuleExecution {
  id: string;
  ruleId: string;
  eventId: string;
  status: "matched" | "skipped" | "running" | "succeeded" | "failed" | "uncertain" | "rateLimited";
  detail: Record<string, unknown>;
  createdAt: string;
  completedAt?: string;
}

export interface RuleJob {
  id: string;
  ruleId: string;
  eventId: string;
  revision?: number;
  attempt: number;
  state: "pending" | "running" | "succeeded" | "failed" | "cancelled";
  availableAt: string;
  createdAt: string;
  lastErrorCode?: string;
}

export interface UsageLimits {
  connections: number;
  pollSubscriptionsPerConnection: number;
  forwardDestinationsPerConnection: number;
  rawMirrorsPerConnection: number;
  rulesPerConnection: number;
  conditionsPerRule: number;
  actionsPerRule: number;
}

export interface RequestIdentity {
  accountId: string;
  requestId: string;
}

export interface AuditEntry {
  id: string;
  accountId: string;
  connectionId?: string;
  action: string;
  requestId: string;
  statusCode: number;
  createdAt: string;
}
