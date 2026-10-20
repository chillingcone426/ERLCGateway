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

  let previous: Record<string, number> = {};
  try {
    const parsed = JSON.parse(await fs.readFile(statePath!, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) previous = parsed as Record<string, number>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const now = Date.now();
  const next: Record<string, number> = {};
  for (const [code, message] of Object.entries(alerts)) {
    if (!previous[code] || now - previous[code] >= 60 * 60_000) {
      await sendDiscord(webhookUrl!, `⚠️ LibertyTools operator alert: ${message}`);
      next[code] = now;
    } else next[code] = previous[code];
  }
  for (const code of Object.keys(previous)) {
    if (!alerts[code]) await sendDiscord(webhookUrl!, `✅ LibertyTools recovered: ${code.replaceAll("_", " ")}.`);
  }
  const temporary = `${statePath!}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
  await fs.rename(temporary, statePath!);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  monitor().catch(error => { console.error(error instanceof Error ? error.message : "Monitor failed"); process.exitCode = 1; });
}
