import type { GatewayConfig } from "./config.js";
import type { GatewayStore } from "./store.js";
import type { ProviderRequestSample } from "./types.js";

function nonnegativeHeader(headers: Headers, name: string) {
  const raw = headers.get(name);
  if (raw === null || !/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

export function monitorErlcFetch(fetcher: typeof fetch, store: GatewayStore, config: GatewayConfig,
  onTelemetryError: (error: unknown) => void = () => {}) : typeof fetch {
  const base = new URL(config.erlcApiBaseUrl);
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== base.origin || !url.pathname.startsWith(`${base.pathname}/`)) return fetcher(input, init);
    const operation: ProviderRequestSample["operation"] = url.pathname.endsWith("/command") ? "command"
      : url.searchParams.get("Players") === "true" ? "players" : "server";
    const started = Date.now();
    let response: Response | undefined;
    try {
      response = await fetcher(input, init);
      const remaining = nonnegativeHeader(response.headers, "x-ratelimit-remaining");
      const reset = nonnegativeHeader(response.headers, "x-ratelimit-reset");
      const bucket = response.headers.get("x-ratelimit-bucket")?.toLowerCase();
      if (remaining === 0 && reset !== undefined && (bucket === "global" || bucket === "command")) {
        const delay = reset * 1000 - Date.now();
        if (delay > 0 && delay <= 60 * 60_000) {
          try {
            await store.setCooldown(bucket === "global" ? "erlc:provider:global" : "erlc:command:global", delay + 250);
          } catch (error) { onTelemetryError(error); }
        }
      }
      return response;
    } finally {
      const headers = response?.headers;
      const bucket = headers?.get("x-ratelimit-bucket")?.toLowerCase();
      const limit = headers ? nonnegativeHeader(headers, "x-ratelimit-limit") : undefined;
      const remaining = headers ? nonnegativeHeader(headers, "x-ratelimit-remaining") : undefined;
      const sample: ProviderRequestSample = {
        operation, latencyMs: Math.max(0, Date.now() - started), recordedAt: new Date().toISOString(),
        ...(response ? { statusCode: response.status } : {}),
        ...(bucket && /^[a-z0-9_-]{1,40}$/.test(bucket) ? { rateLimitBucket: bucket } : {}),
        ...(limit !== undefined ? { rateLimitLimit: limit } : {}),
        ...(remaining !== undefined ? { rateLimitRemaining: remaining } : {})
      };
      try { await store.recordProviderRequest(sample); } catch (error) { onTelemetryError(error); }
    }
  };
}
