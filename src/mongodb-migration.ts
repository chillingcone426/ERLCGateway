import crypto from "node:crypto";
import type { Document, WithId } from "mongodb";
import { normalizeWebhookEvent } from "./normalization.js";
import { randomId, validateDestinationUrl } from "./security.js";
import type { Connection, ForwardDestination, GatewayEvent, LegacyPreset, PollSubscription } from "./types.js";

export interface LegacyWebhook extends Document {
  webhookId?: unknown;
  robloxID?: unknown;
  robloxId?: unknown;
  username?: unknown;
  webhookURL?: unknown;
  webhookUrl?: unknown;
  mode?: unknown;
  createdAt?: unknown;
}

export interface LegacyQueuedEvent extends Document {
  webhookId?: unknown;
  event?: unknown;
  userId?: unknown;
  timestamp?: unknown;
  server?: unknown;
  createdAt?: unknown;
}

export interface WebhookMigrationPlan {
  sourceId: string;
  connection?: Connection;
  subscription?: PollSubscription;
  destination?: ForwardDestination;
  warning?: string;
  error?: string;
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : value === undefined || value === null ? "" : String(value).trim();
}

function stableId(prefix: string, ...parts: string[]) {
  const value = crypto.createHash("sha256").update(parts.join("\0"), "utf8").digest("base64url").slice(0, 24);
  return `${prefix}_mig_${value}`;
}

function date(value: unknown, fallback = new Date().toISOString()) {
  if (value instanceof Date && Number.isFinite(value.valueOf())) return value.toISOString();
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value > 10_000_000_000 ? value : value * 1000;
    return new Date(milliseconds).toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return date(numeric, fallback);
    const parsed = new Date(value);
    if (Number.isFinite(parsed.valueOf())) return parsed.toISOString();
  }
  return fallback;
}

function legacyMode(value: unknown): LegacyPreset | undefined {
  const mode = text(value).toLowerCase();
  return mode === "poll" || mode === "proxy" || mode === "easy" ? mode : undefined;
}

function transport(url: string): "encrypted" | "unencrypted" {
  return new URL(url).protocol === "https:" ? "encrypted" : "unencrypted";
}

export function planLegacyWebhook(document: WithId<LegacyWebhook>, now = new Date().toISOString()): WebhookMigrationPlan {
  const sourceId = text(document._id);
  const publicId = text(document.webhookId);
  const accountId = text(document.robloxID ?? document.robloxId);
  const mode = legacyMode(document.mode);
  if (!publicId) return { sourceId, error: "webhookId is missing" };
  if (!accountId) return { sourceId, error: "robloxID is missing" };
  if (!mode) return { sourceId, error: `unsupported mode: ${text(document.mode) || "missing"}` };
  const createdAt = date(document.createdAt, now);
  const username = text(document.username) || "Roblox user";
  const connectionId = stableId("con", publicId);
  const connection: Connection = {
    id: connectionId,
    accountId,
    name: `${username} (${mode})`,
    publicId,
    paused: false,
    legacyPreset: mode,
    createdAt,
    updatedAt: now
  };
  if (mode === "poll") {
    const placeholder = randomId("migration-token");
    return {
      sourceId,
      connection,
      subscription: {
        id: stableId("sub", publicId, "legacy-poll"),
        connectionId,
        name: "Legacy Poll adapter",
        tokenHash: crypto.createHash("sha256").update(placeholder).digest("hex"),
        tokenPrefix: "migration-only",
        eventTypes: [], includedCommands: [], excludedCommands: [], createdAt
      },
      warning: "Legacy Poll URL remains active. Rotate this subscription in the dashboard to obtain v2 credentials."
    };
  }
  const url = text(document.webhookURL ?? document.webhookUrl);
  if (!url) return { sourceId, connection, warning: `${mode} destination URL is missing; the connection can be repaired in the dashboard.` };
  try { new URL(url); } catch { return { sourceId, connection, warning: `${mode} destination URL is invalid; the connection can be repaired in the dashboard.` }; }
  const type = mode === "proxy" ? "rawMirror" as const : "legacyEasy" as const;
  return {
    sourceId,
    connection,
    destination: {
      id: stableId("dst", publicId, mode),
      connectionId,
      name: mode === "proxy" ? "Migrated Proxy destination" : "Migrated Easy destination",
      type,
      url,
      providerPreset: mode === "proxy" ? "legacy-proxy" : "legacy-easy",
      healthState: "probation",
      enabled: true,
      transportSecurity: transport(url),
      consecutiveFailures: 0,
      successfulDeliveries: 0,
      filter: { eventTypes: [], commandPolicy: "all", includedCommands: [], excludedCommands: [] },
      createdAt,
      updatedAt: now
    }
  };
}

export async function validatePlannedDestination(plan: WebhookMigrationPlan) {
  if (!plan.destination) return plan;
  try {
    const validated = await validateDestinationUrl(plan.destination.url);
    return { ...plan, destination: { ...plan.destination, url: validated.url.toString(), transportSecurity: validated.transportSecurity } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const { destination: _destination, ...rest } = plan;
    return { ...rest, warning: `Destination was not imported: ${message}. The connection was preserved for manual repair.` };
  }
}

export function mapLegacyQueuedEvent(
  document: WithId<LegacyQueuedEvent>,
  connectionId: string,
  now = new Date().toISOString()
): GatewayEvent {
  const rawDocument = Object.fromEntries(Object.entries(document).filter(([key]) => key !== "_id" && key !== "webhookId" && key !== "createdAt"));
  const rawBody = Buffer.from(JSON.stringify(rawDocument), "utf8");
  const receivedAt = date(document.createdAt, now);
  const normalized = normalizeWebhookEvent({ connectionId, rawBody, payload: rawDocument, headers: {}, receivedAt });
  const sourceId = text(document._id);
  return {
    ...normalized,
    id: stableId("evt", connectionId, sourceId),
    dedupeKey: `mongodb:${sourceId}`,
    receivedAt,
    occurredAt: date(document.timestamp, receivedAt)
  };
}
