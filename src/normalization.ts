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

export function normalizeWebhookEvent(options: {
  connectionId: string;
  rawBody: Buffer;
  payload: unknown;
  headers: Record<string, string>;
  receivedAt?: string;
  synthetic?: boolean;
}): GatewayEvent {
  const input = record(options.payload);
  const nested = record(input.data);
  const eventName = stringValue(input.event, input.type, nested.event, nested.type);
  const normalizedType = normalizeType(eventName);
  const receivedAt = options.receivedAt ?? new Date().toISOString();
  const occurredAt = stringValue(input.timestamp, nested.timestamp) ?? receivedAt;
  const data: Record<string, unknown> = normalizedType.type === "CustomCommand"
    ? {
        userId: stringValue(input.userId, input.userID, nested.userId, nested.userID) ?? "",
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
    .update(options.rawBody)
    .digest("hex");
  return {
    id: randomId("evt"),
    connectionId: options.connectionId,
    type: normalizedType.type,
    ...(normalizedType.originalType ? { originalType: normalizedType.originalType } : {}),
    occurredAt,
    receivedAt,
    ...(stringValue(input.serverId, input.server, nested.serverId, nested.server)
      ? { serverId: stringValue(input.serverId, input.server, nested.serverId, nested.server)! }
      : {}),
    data,
    rawBody: options.rawBody,
    originalHeaders: options.headers,
    synthetic: options.synthetic ?? false,
    dedupeKey
  };
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
