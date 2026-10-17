import type { GatewayConfig } from "./config.js";
import type { GatewayStore } from "./store.js";

export class MaintenanceWorker {
  readonly #store: GatewayStore;
  readonly #config: GatewayConfig;
  readonly #now: () => number;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: { store: GatewayStore; config: GatewayConfig; now?: () => number }) {
    this.#store = options.store; this.#config = options.config; this.#now = options.now ?? Date.now;
  }

  start() {
    if (this.#timer) return;
    void this.runOnce();
    this.#timer = setInterval(() => { void this.runOnce(); }, this.#config.maintenanceIntervalMs);
    this.#timer.unref();
  }

  stop() { if (this.#timer) clearInterval(this.#timer); this.#timer = undefined; }

  async runOnce() {
    const day = 24 * 60 * 60_000;
    return await this.#store.cleanup(
      new Date(this.#now() - this.#config.eventRetentionDays * day).toISOString(),
      new Date(this.#now() - this.#config.auditRetentionDays * day).toISOString()
    );
  }
}
