import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { MongoClient, type WithId } from "mongodb";
import { Pool, type PoolClient } from "pg";
import { mapLegacyQueuedEvent, planLegacyWebhook, validatePlannedDestination, type LegacyQueuedEvent, type LegacyWebhook, type WebhookMigrationPlan } from "./mongodb-migration.js";

interface ReportItem {
  sourceId: string;
  webhookId?: string;
  accountId?: string;
  mode?: string;
  status: "planned" | "created" | "existing" | "skipped" | "conflict";
  output?: string;
  importedEvents: number;
  message?: string;
}

interface MigrationReport {
  version: 1;
  dryRun: boolean;
  includeEvents: boolean;
  source: { database: string; webhooksCollection: string; eventsCollection: string };
  startedAt: string;
  completedAt?: string;
  summary: { scanned: number; planned: number; created: number; existing: number; skipped: number; conflicts: number; importedEvents: number };
  items: ReportItem[];
}

function argumentsFrom(argv: string[]) {
  let reportPath = "";
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--report") reportPath = argv[index + 1] ?? "";
    else if (argv[index]?.startsWith("--report=")) reportPath = argv[index]!.slice("--report=".length);
  }
  const known = new Set(["--apply", "--include-events", "--help", "--report"]);
  const unknown = argv.filter((value, index) => value.startsWith("--") && !known.has(value) && !value.startsWith("--report=") && argv[index - 1] !== "--report");
  if (unknown.length) throw new Error(`Unknown option: ${unknown.join(", ")}`);
  return { apply: argv.includes("--apply"), includeEvents: argv.includes("--include-events"), help: argv.includes("--help"), reportPath };
}

function usage() {
  return `MongoDB to PostgreSQL migration\n\n` +
    `Dry run: npm run migrate:mongodb -- --report migration-report.json\n` +
    `Apply:   npm run migrate:mongodb -- --apply --include-events --report migration-report.json\n\n` +
    `Environment:\n` +
    `  MONGO_URI       Source connection (default mongodb://127.0.0.1:27017)\n` +
    `  MONGO_DB_NAME   Source database (default erlc_gateway)\n` +
    `  DATABASE_URL    PostgreSQL target; required with --apply\n` +
    `  MONGO_WEBHOOKS_COLLECTION (default webhooks)\n` +
    `  MONGO_EVENTS_COLLECTION   (default webhookEvents)\n\n` +
    `MongoDB is always read-only. Dry run is the default. --include-events imports queued events without forwarding them.`;
}

async function initializeTarget(pool: Pool) {
  const directory = path.join(process.cwd(), "migrations");
  const files = (await fs.readdir(directory)).filter(name => name.endsWith(".sql")).sort();
  for (const file of files) await pool.query(await fs.readFile(path.join(directory, file), "utf8"));
}

async function insertPlan(client: PoolClient, plan: WebhookMigrationPlan) {
  const connection = plan.connection!;
  const existing = await client.query("SELECT id, account_id, legacy_preset FROM connections WHERE public_id=$1", [connection.publicId]);
  if (existing.rows[0]) {
    if (String(existing.rows[0].id) !== connection.id || String(existing.rows[0].account_id) !== connection.accountId) {
      return { status: "conflict" as const, message: "The webhook ID already belongs to a different v2 connection." };
    }
  } else {
    await client.query(`INSERT INTO connections
      (id,account_id,name,public_id,paused,legacy_preset,created_at,updated_at)
      VALUES($1,$2,$3,$4,false,$5,$6,$7)`, [connection.id, connection.accountId, connection.name,
      connection.publicId, connection.legacyPreset, connection.createdAt, connection.updatedAt]);
  }
  if (plan.subscription) {
    const value = plan.subscription;
    await client.query(`INSERT INTO poll_subscriptions
      (id,connection_id,name,token_hash,token_prefix,event_types,included_commands,excluded_commands,created_at)
      VALUES($1,$2,$3,$4,$5,'[]','[]','[]',$6) ON CONFLICT(id) DO NOTHING`,
    [value.id, value.connectionId, value.name, value.tokenHash, value.tokenPrefix, value.createdAt]);
  }
  if (plan.destination) {
    const value = plan.destination;
    await client.query(`INSERT INTO forward_destinations
      (id,connection_id,name,type,url,provider_preset,health_state,enabled,transport_security,consecutive_failures,successful_deliveries,filter,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,0,0,$10,$11,$12) ON CONFLICT(id) DO NOTHING`,
    [value.id, value.connectionId, value.name, value.type, value.url, value.providerPreset ?? null,
      value.healthState, value.enabled, value.transportSecurity, JSON.stringify(value.filter), value.createdAt, value.updatedAt]);
  }
  return { status: existing.rows[0] ? "existing" as const : "created" as const };
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  if (options.help) { console.log(usage()); return; }
  const mongoUri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017";
  const databaseName = process.env.MONGO_DB_NAME || "erlc_gateway";
  const webhooksCollection = process.env.MONGO_WEBHOOKS_COLLECTION || "webhooks";
  const eventsCollection = process.env.MONGO_EVENTS_COLLECTION || "webhookEvents";
  const databaseUrl = process.env.DATABASE_URL || "";
  if (options.apply && !databaseUrl) throw new Error("DATABASE_URL is required with --apply.");
  const report: MigrationReport = {
    version: 1, dryRun: !options.apply, includeEvents: options.includeEvents,
    source: { database: databaseName, webhooksCollection, eventsCollection },
    startedAt: new Date().toISOString(),
    summary: { scanned: 0, planned: 0, created: 0, existing: 0, skipped: 0, conflicts: 0, importedEvents: 0 },
    items: []
  };
  const mongo = new MongoClient(mongoUri, { readPreference: "secondaryPreferred" });
  const pool = options.apply ? new Pool({ connectionString: databaseUrl, max: 4 }) : undefined;
  try {
    await mongo.connect();
    if (pool) await initializeTarget(pool);
    const database = mongo.db(databaseName);
    const webhooks = await database.collection<LegacyWebhook>(webhooksCollection).find({}, { sort: { createdAt: 1 } }).toArray();
    for (const document of webhooks) {
      report.summary.scanned += 1;
      let plan = planLegacyWebhook(document);
      if (plan.destination) plan = await validatePlannedDestination(plan);
      const item: ReportItem = {
        sourceId: plan.sourceId,
        ...(plan.connection ? { webhookId: plan.connection.publicId, accountId: plan.connection.accountId, mode: plan.connection.legacyPreset } : {}),
        status: "planned",
        ...(plan.subscription ? { output: "legacy Poll adapter" } : plan.destination ? { output: plan.destination.type } : {}),
        importedEvents: 0,
        ...(plan.warning ? { message: plan.warning } : {})
      };
      if (!plan.connection || plan.error) {
        item.status = "skipped";
        item.message = plan.error ?? "Webhook could not be planned.";
        report.summary.skipped += 1;
        report.items.push(item);
        continue;
      }
      if (!options.apply) {
        report.summary.planned += 1;
        if (options.includeEvents) item.importedEvents = await database.collection<LegacyQueuedEvent>(eventsCollection).countDocuments({ webhookId: plan.connection.publicId });
        report.items.push(item);
        continue;
      }
      const client = await pool!.connect();
      try {
        await client.query("BEGIN");
        const result = await insertPlan(client, plan);
        item.status = result.status;
        if (result.message) item.message = result.message;
        if (result.status === "conflict") {
          report.summary.conflicts += 1;
          await client.query("ROLLBACK");
          report.items.push(item);
          continue;
        }
        report.summary[result.status] += 1;
        if (options.includeEvents) {
          const queued = await database.collection<LegacyQueuedEvent>(eventsCollection).find({ webhookId: plan.connection.publicId }).toArray();
          for (const sourceEvent of queued) {
            const event = mapLegacyQueuedEvent(sourceEvent, plan.connection.id);
            const inserted = await client.query(`INSERT INTO events
              (id,connection_id,type,original_type,occurred_at,received_at,server_id,data,raw_body,original_headers,synthetic,dedupe_key)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,$11)
              ON CONFLICT(connection_id,dedupe_key) DO NOTHING RETURNING id`, [event.id, event.connectionId,
              event.type, event.originalType ?? null, event.occurredAt, event.receivedAt, event.serverId ?? null,
              JSON.stringify(event.data), event.rawBody, JSON.stringify(event.originalHeaders), event.dedupeKey]);
            if (inserted.rowCount) item.importedEvents += 1;
          }
          report.summary.importedEvents += item.importedEvents;
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      report.items.push(item);
    }
  } finally {
    await mongo.close();
    await pool?.end();
  }
  report.completedAt = new Date().toISOString();
  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  if (options.reportPath) await fs.writeFile(path.resolve(options.reportPath), rendered, { encoding: "utf8", flag: "wx" });
  console.log(rendered);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
