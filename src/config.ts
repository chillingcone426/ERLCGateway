import crypto from "node:crypto";

const OFFICIAL_ERLC_PUBLIC_KEY = "MCowBQYDK2VwAyEAjSICb9pp0kHizGQtdG8ySWsDChfGqi+gyFCttigBNOA=";

function integer(value: string | undefined, fallback: number, name: string) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

function base64Key(value: string | undefined, required: boolean) {
  if (!value) {
    if (required) throw new Error("SECRET_ENCRYPTION_KEY_BASE64 is required in production");
    return crypto.randomBytes(32);
  }
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error("SECRET_ENCRYPTION_KEY_BASE64 must decode to exactly 32 bytes");
  return key;
}

export interface GatewayConfig {
  host: string;
  port: number;
  baseUrl: string;
  databaseUrl?: string;
  managementApiToken: string;
  erlcPublicKeySpkiBase64: string;
  webhookMaxClockSkewSeconds: number;
  encryptionKey: Buffer;
  forwardTimeoutMs: number;
  forwardMaxAttempts: number;
  forwardRetryWindowMs: number;
  workerPollMs: number;
  erlcApiBaseUrl: string;
  eventRetentionDays: number;
  auditRetentionDays: number;
  maintenanceIntervalMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const managementApiToken = env.MANAGEMENT_API_TOKEN?.trim();
  if (!managementApiToken) throw new Error("MANAGEMENT_API_TOKEN is required");
  return {
    host: env.HOST ?? "0.0.0.0",
    port: integer(env.PORT, 3000, "PORT"),
    baseUrl: (env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, ""),
    ...(env.DATABASE_URL ? { databaseUrl: env.DATABASE_URL } : {}),
    managementApiToken,
    erlcPublicKeySpkiBase64: env.ERLC_PUBLIC_KEY_SPKI_BASE64 ?? OFFICIAL_ERLC_PUBLIC_KEY,
    webhookMaxClockSkewSeconds: integer(env.WEBHOOK_MAX_CLOCK_SKEW_SECONDS, 300, "WEBHOOK_MAX_CLOCK_SKEW_SECONDS"),
    encryptionKey: base64Key(env.SECRET_ENCRYPTION_KEY_BASE64, env.NODE_ENV === "production"),
    forwardTimeoutMs: integer(env.FORWARD_TIMEOUT_MS, 5_000, "FORWARD_TIMEOUT_MS"),
    forwardMaxAttempts: integer(env.FORWARD_MAX_ATTEMPTS, 5, "FORWARD_MAX_ATTEMPTS"),
    forwardRetryWindowMs: integer(env.FORWARD_RETRY_WINDOW_MS, 15 * 60_000, "FORWARD_RETRY_WINDOW_MS"),
    workerPollMs: integer(env.WORKER_POLL_MS, 500, "WORKER_POLL_MS"),
    erlcApiBaseUrl: (env.ERLC_API_BASE_URL ?? "https://api.erlc.gg/v2").replace(/\/$/, ""),
    eventRetentionDays: integer(env.EVENT_RETENTION_DAYS, 14, "EVENT_RETENTION_DAYS"),
    auditRetentionDays: integer(env.AUDIT_RETENTION_DAYS, 90, "AUDIT_RETENTION_DAYS"),
    maintenanceIntervalMs: integer(env.MAINTENANCE_INTERVAL_MS, 60 * 60_000, "MAINTENANCE_INTERVAL_MS")
  };
}
