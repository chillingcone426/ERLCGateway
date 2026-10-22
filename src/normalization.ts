import crypto from "node:crypto";
import type { GatewayEvent } from "./types.js";
import { randomId } from "./security.js";

function stringValue(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeType(value: string | undefined) {
  if (!value) return { type: "Unknown", originalType: "Unknown" };
  const lower = value.toLowerCase();
  const known: Record<string, string> = {
    customcommand: "CustomCommand",
    emergencycall: "EmergencyCall",
    modcall: "ModCall",
    playerjoin: "PlayerJoin",
    playerjoined: "PlayerJoin",
    playerleave: "PlayerLeave",
    playerleft: "PlayerLeave",
    webhookprobe: "WebhookProbe"
  };
  return known[lower]
    ? { type: known[lower]!, originalType: value }
    : { type: "Unknown", originalType: value };
}

function timestamp(value: unknown, fallback: string) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value > 10_000_000_000 ? value : value * 1000).toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return timestamp(numeric, fallback);
    const parsed = new Date(value);
    if (Number.isFinite(parsed.valueOf())) return parsed.toISOString();
  }
  return fallback;
}

export interface NormalizeWebhookOptions {
  connectionId: string;
  rawBody: Buffer;
  payload: unknown;
  headers: Record<string, string>;
  receivedAt?: string;
  synthetic?: boolean;
}

function normalizeOne(options: NormalizeWebhookOptions, payload: unknown, envelope: Record<string, unknown>, batchIndex?: number): GatewayEvent {
  const input = record(payload);
  const nested = record(input.data);
  const eventName = stringValue(input.event, input.type, nested.event, nested.type);
  const normalizedType = normalizeType(eventName);
  const receivedAt = options.receivedAt ?? new Date().toISOString();
  const occurredAt = timestamp(input.timestamp ?? nested.timestamp, receivedAt);
  const data: Record<string, unknown> = normalizedType.type === "CustomCommand"
    ? {
        userId: stringValue(input.origin, input.userId, input.userID, nested.userId, nested.userID) ?? "",
        ...(stringValue(input.username, input.playerName, nested.username, nested.playerName)
          ? { username: stringValue(input.username, input.playerName, nested.username, nested.playerName)! }
          : {}),
        command: (stringValue(input.command, nested.command) ?? "").replace(/^;/, "").toLowerCase(),
        argument: stringValue(input.argument, nested.argument) ?? ""
      }
    : { ...nested, ...(Object.keys(nested).length ? {} : input) };
  const dedupeKey = crypto.createHash("sha256")
    .update(options.connectionId)
    .update("\0")
    .update(options.headers["x-signature-timestamp"] ?? "")
    .update("\0")
    .update(options.rawBody)
    .update(batchIndex === undefined ? "" : `\0batch:${batchIndex}`)
    .digest("hex");
  const envelopeServer = record(envelope.server);
  return {
    id: randomId("evt"),
    connectionId: options.connectionId,
    type: normalizedType.type,
    ...(normalizedType.originalType ? { originalType: normalizedType.originalType } : {}),
    occurredAt,
    receivedAt,
    ...(stringValue(input.serverId, input.server, nested.serverId, nested.server, envelope.server, envelopeServer.id)
      ? { serverId: stringValue(input.serverId, input.server, nested.serverId, nested.server, envelope.server, envelopeServer.id)! }
      : {}),
    data,
    rawBody: options.rawBody,
    originalHeaders: options.headers,
    synthetic: options.synthetic ?? false,
    dedupeKey
  };
}

export function normalizeWebhookEvents(options: NormalizeWebhookOptions): GatewayEvent[] {
  const envelope = record(options.payload);
  const batch = Array.isArray(envelope.events)
    ? envelope.events.filter(value => value && typeof value === "object" && !Array.isArray(value))
    : [];
  if (!batch.length) return [normalizeOne(options, options.payload, envelope)];
  return batch.map((payload, index) => normalizeOne(options, payload, envelope, index));
}

export function normalizeWebhookEvent(options: NormalizeWebhookOptions): GatewayEvent {
  return normalizeWebhookEvents(options)[0]!;
}

export function encodeCursor(event: GatewayEvent) {
  return Buffer.from(JSON.stringify([event.receivedAt, event.id]), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | undefined) {
  if (!cursor) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2 || parsed.some(value => typeof value !== "string")) throw new Error();
    return { receivedAt: parsed[0] as string, id: parsed[1] as string };
  } catch {
    throw Object.assign(new Error("Cursor is invalid"), { code: "cursor_invalid" });
  }
}
