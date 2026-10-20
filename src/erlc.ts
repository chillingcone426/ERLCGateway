import type { GatewayConfig } from "./config.js";

export function erlcHeaders(config: GatewayConfig, serverKey: string) {
  if (!config.erlcGlobalApiKey) throw new Error("ERLC_GLOBAL_API_KEY is not configured");
  return { Authorization: config.erlcGlobalApiKey, "Server-Key": serverKey };
}

export function erlcInternalServerId(serverKey: string) {
  const separator = serverKey.lastIndexOf("-");
  const id = separator >= 0 ? serverKey.slice(separator + 1) : "";
  return /^[A-Za-z0-9]+$/.test(id) ? id : undefined;
}

export function erlcRetryAfterMs(response: Response, now = Date.now()) {
  const raw = response.headers.get("retry-after");
  if (!raw) return 60_000;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(raw);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - now) : 60_000;
}
