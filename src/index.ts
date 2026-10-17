import { loadConfig } from "./config.js";
import { PostgresGatewayStore } from "./postgres-store.js";
import { createApp } from "./server.js";

const config = loadConfig();
if (!config.databaseUrl) throw new Error("DATABASE_URL is required");
const store = new PostgresGatewayStore(config.databaseUrl);
await store.init();
const { app, worker, ruleWorker, maintenanceWorker } = await createApp({ config, store, logger: true });
worker.start();
ruleWorker.start();
maintenanceWorker.start();

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exit(1);
}
