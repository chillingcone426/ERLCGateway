import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";

export interface ProviderWindow {
  total: number;
  errors: number;
  rateLimited: number;
  lowRemaining: number;
  p95LatencyMs: number;
}

export function providerAlerts(window: ProviderWindow) {
  const alerts: Record<string, string> = {};
  if (window.errors >= 3 || (window.total >= 8 && window.errors / window.total >= 0.25)) {
    alerts.provider_errors = `ER:LC API errors: ${window.errors} of ${window.total} requests in 15 minutes.`;
  }
  if (window.rateLimited >= 2) {
    alerts.provider_rate_limits = `ER:LC returned HTTP 429 ${window.rateLimited} times in 15 minutes.`;
  }
  if (window.total >= 5 && window.p95LatencyMs >= 3_000) {
    alerts.provider_latency = `ER:LC 95th percentile latency: ${Math.round(window.p95LatencyMs)} ms over ${window.total} requests.`;
  }
  if (window.lowRemaining >= 2) {
    alerts.provider_budget = `ER:LC global rate-limit remaining reached 2 or fewer on ${window.lowRemaining} responses in 15 minutes.`;
  }
  return alerts;
}

// The monitor normally runs every five minutes. Require three matching observations
// spanning at least ten minutes before announcing either side of a transition.
export const HEALTH_CONFIRMATIONS = 3;
export const HEALTH_CONFIRMATION_MS = 10 * 60_000;

export interface AlertState {
  status: "pending_down" | "down" | "pending_up";
  firstObservedAt: number;
  observations: number;
}

export function advanceAlertState(
  previous: Record<string, AlertState>,
  alerts: Record<string, string>,
  now: number
): { state: Record<string, AlertState>; notifications: string[] } {
  const state: Record<string, AlertState> = {};
  const notifications: string[] = [];
  for (const code of new Set([...Object.keys(previous), ...Object.keys(alerts)])) {
    const prior = previous[code];
    const message = alerts[code];
    if (message) {
      if (!prior) {
        state[code] = { status: "pending_down", firstObservedAt: now, observations: 1 };
      } else if (prior.status === "down") {
        state[code] = prior;
      } else if (prior.status === "pending_up") {
        state[code] = { status: "down", firstObservedAt: now, observations: 0 };
      } else {
        const observations = prior.observations + 1;
        if (observations >= HEALTH_CONFIRMATIONS && now - prior.firstObservedAt >= HEALTH_CONFIRMATION_MS) {
          state[code] = { status: "down", firstObservedAt: now, observations: 0 };
          notifications.push(`⚠️ LibertyTools operator alert: ${message}`);
        } else state[code] = { ...prior, observations };
      }
    } else if (prior?.status === "down") {
      state[code] = { status: "pending_up", firstObservedAt: now, observations: 1 };
    } else if (prior?.status === "pending_up") {
      const observations = prior.observations + 1;
      if (observations >= HEALTH_CONFIRMATIONS && now - prior.firstObservedAt >= HEALTH_CONFIRMATION_MS) {
        notifications.push(`✅ LibertyTools recovered: ${code.replaceAll("_", " ")}.`);
      } else state[code] = { ...prior, observations };
    }
  }
  return { state, notifications };
}

export function parseAlertState(value: unknown): Record<string, AlertState> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const state: Record<string, AlertState> = {};
  for (const [code, entry] of Object.entries(value)) {
    // Older monitor versions recorded the last notification time as a number.
    if (typeof entry === "number" && Number.isFinite(entry)) {
      state[code] = { status: "down", firstObservedAt: entry, observations: 0 };
    } else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const candidate = entry as Partial<AlertState>;
      if (["pending_down", "down", "pending_up"].includes(candidate.status ?? "") &&
        typeof candidate.firstObservedAt === "number" && Number.isFinite(candidate.firstObservedAt) &&
        typeof candidate.observations === "number" && Number.isInteger(candidate.observations) &&
        candidate.observations >= 0) state[code] = candidate as AlertState;
    }
  }
  return state;
}

async function serviceProblem(url: string, expectedStatus: number) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    return response.status === expectedStatus ? "" : `HTTP ${response.status}`;
  } catch { return "unreachable"; }
}

async function sendDiscord(webhookUrl: string, content: string) {
  const response = await fetch(webhookUrl, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(8_000)
  });
  if (!response.ok) throw new Error(`Discord alert delivery failed with HTTP ${response.status}`);
}

async function monitor() {
  const dryRun = process.argv.includes("--dry-run");
  const databaseUrl = process.env.DATABASE_URL;
  const statePath = process.env.OPS_MONITOR_STATE_PATH;
  const webhookUrl = process.env.DISCORD_ALERT_WEBHOOK_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  if (!dryRun && (!statePath || !webhookUrl)) {
    throw new Error("OPS_MONITOR_STATE_PATH and DISCORD_ALERT_WEBHOOK_URL are required");
  }
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  let window: ProviderWindow;
  try {
    const result = await pool.query(`SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE status_code IS NULL OR (status_code >= 400 AND status_code <> 429))::int AS errors,
      count(*) FILTER (WHERE status_code = 429)::int AS rate_limited,
      count(*) FILTER (WHERE rate_limit_bucket = 'global' AND rate_limit_remaining <= 2)::int AS low_remaining,
      coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms), 0) AS p95_latency_ms
      FROM provider_requests WHERE recorded_at >= now() - interval '15 minutes'`);
    const row = result.rows[0];
    window = {
      total: Number(row.total), errors: Number(row.errors), rateLimited: Number(row.rate_limited),
      lowRemaining: Number(row.low_remaining), p95LatencyMs: Number(row.p95_latency_ms)
    };
  } finally { await pool.end(); }
  const alerts = providerAlerts(window);
  const gatewayProblem = await serviceProblem(process.env.OPS_GATEWAY_HEALTH_URL ?? "https://api.libertytools.dev/health/ready", 200);
  const dashboardProblem = await serviceProblem(process.env.OPS_DASHBOARD_HEALTH_URL ?? "https://dash.libertytools.dev/login", 200);
  if (gatewayProblem) alerts.gateway_health = `LibertyTools gateway is ${gatewayProblem}.`;
  if (dashboardProblem) alerts.dashboard_health = `LibertyTools dashboard is ${dashboardProblem}.`;
  if (dryRun) { console.log(JSON.stringify({ window, alerts })); return; }

  let previous: Record<string, AlertState> = {};
  try {
    const parsed = JSON.parse(await fs.readFile(statePath!, "utf8")) as unknown;
    previous = parseAlertState(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const { state, notifications } = advanceAlertState(previous, alerts, Date.now());
  for (const notification of notifications) await sendDiscord(webhookUrl!, notification);
  const temporary = `${statePath!}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
  await fs.rename(temporary, statePath!);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  monitor().catch(error => { console.error(error instanceof Error ? error.message : "Monitor failed"); process.exitCode = 1; });
}
