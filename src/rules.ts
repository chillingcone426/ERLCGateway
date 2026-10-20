import type { GatewayConfig } from "./config.js";
import { RUNTIME_LIMITS } from "./limits.js";
import { decryptSecret, randomId } from "./security.js";
import type { GatewayStore } from "./store.js";
import type { GatewayEvent, Rule, RuleAction, RuleDefinition, RuleExecution } from "./types.js";

function commandName(event: GatewayEvent) {
  return event.type === "CustomCommand" && typeof event.data.command === "string"
    ? event.data.command.toLowerCase()
    : "";
}

function argument(event: GatewayEvent) {
  return typeof event.data.argument === "string" ? event.data.argument : "";
}

function playerId(event: GatewayEvent) {
  return typeof event.data.userId === "string" ? event.data.userId : "";
}

function parseArgs(input: string) {
  const values = input.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return values.map(value => value.replace(/^("|')|("|')$/g, ""));
}

export function normalizeCommand(value: unknown) {
  if (typeof value !== "string") return "";
  const command = value.trim().replace(/^;/, "").toLowerCase();
  return command && !/\s/.test(command) ? command : "";
}

export function validateRuleDefinition(value: unknown, limits = { conditions: 10, actions: 1 }): RuleDefinition {
  if (!value || typeof value !== "object") throw Object.assign(new Error("Rule definition is required"), { code: "validation_failed" });
  const input = value as Partial<RuleDefinition>;
  if (!input.trigger || typeof input.trigger !== "object") throw Object.assign(new Error("Rule trigger is required"), { code: "validation_failed" });
  let trigger: RuleDefinition["trigger"];
  if (input.trigger.type === "customCommand") {
    const command = normalizeCommand(input.trigger.command);
    if (!command) throw Object.assign(new Error("Custom command name is invalid"), { code: "validation_failed" });
    trigger = { type: "customCommand", command };
  } else throw Object.assign(new Error("Hosted actions currently require a custom command trigger"), { code: "validation_failed" });

  const conditions = Array.isArray(input.conditions) ? input.conditions : [];
  const actions = Array.isArray(input.actions) ? input.actions : [];
  if (conditions.length > limits.conditions || actions.length < 1 || actions.length > limits.actions) {
    throw Object.assign(new Error("Rule condition or action limit exceeded"), { code: "limit_reached" });
  }
  for (const action of actions) {
    if (!action || (action.type !== "privateReply" && action.type !== "announce") || typeof action.message !== "string") {
      throw Object.assign(new Error("Rule action is invalid"), { code: "validation_failed" });
    }
    sanitizeMessage(action.message);
  }
  const cooldown = input.cooldown;
  if (cooldown && (!Number.isFinite(cooldown.durationMs) || cooldown.durationMs < RUNTIME_LIMITS.minimumPlayerCooldownMs ||
    !["player", "command", "server"].includes(cooldown.scope))) {
    throw Object.assign(new Error(`Cooldown must be at least ${RUNTIME_LIMITS.minimumPlayerCooldownMs}ms`), { code: "validation_failed" });
  }
  return {
    trigger,
    conditions: conditions as RuleDefinition["conditions"],
    actions: actions as RuleDefinition["actions"],
    ...(cooldown ? { cooldown } : {})
  };
}

export function ruleMatches(definition: RuleDefinition, event: GatewayEvent) {
  if (definition.trigger.type === "customCommand") {
    if (event.type !== "CustomCommand" || commandName(event) !== definition.trigger.command) return false;
  } else if (event.type !== definition.trigger.eventType) return false;
  return definition.conditions.every(condition => {
    if (condition.field === "command.argument") {
      const value = argument(event);
      if (condition.operator === "exists") return Boolean(value);
      if (condition.operator === "equals") return value === condition.value;
      return value.includes(condition.value);
    }
    return condition.operator === "equals" && playerId(event) === condition.value;
  });
}

function sanitizeMessage(value: string) {
  const message = value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (!message || message.length > RUNTIME_LIMITS.maxMessageLength) {
    throw Object.assign(new Error(`Message must be 1-${RUNTIME_LIMITS.maxMessageLength} characters`), { code: "validation_failed" });
  }
  return message;
}

function renderTemplate(template: string, event: GatewayEvent, username: string) {
  const args = parseArgs(argument(event));
  const replacements: Record<string, string> = {
    "player.username": username,
    "player.id": playerId(event),
    "command.name": commandName(event),
    "command.argument": argument(event),
    "server.id": event.serverId ?? ""
  };
  for (let index = 0; index < 20; index += 1) replacements[`args.${index}`] = args[index] ?? "";
  return sanitizeMessage(template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_match, key: string) => replacements[key] ?? ""));
}

export interface RuleEngineOptions {
  store: GatewayStore;
  config: GatewayConfig;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

interface CommandOutcome {
  success: boolean;
  status?: number;
  uncertain?: boolean;
  code?: string;
  providerCode?: number;
  message?: string;
  retryAfterMs?: number;
  credentialDisabled?: boolean;
}

export class RuleEngine {
  readonly #store: GatewayStore;
  readonly #config: GatewayConfig;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;

  constructor(options: RuleEngineOptions) {
    this.#store = options.store;
    this.#config = options.config;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
  }

  async matchingRules(event: GatewayEvent) {
    return (await this.#store.listRules(event.connectionId))
      .filter(rule => rule.enabled && rule.published && ruleMatches(rule.published, event));
  }

  async dryRun(definition: RuleDefinition, event: GatewayEvent) {
    const matched = ruleMatches(definition, event);
    const username = typeof event.data.username === "string" ? event.data.username : "TestPlayer";
    return {
      matched,
      trigger: { matched },
      conditions: definition.conditions.map((condition, index) => ({ index, matched: matched && ruleMatches({ ...definition, conditions: [condition] }, event) })),
      actions: definition.actions.map((action, index) => ({
        index, type: action.type, status: matched ? "would_run" : "skipped",
        ...(matched ? { preview: this.#commandForAction(action, event, username) } : {})
      }))
    };
  }

  async processEvent(event: GatewayEvent, rules?: Rule[]) {
    const matching = rules ?? await this.matchingRules(event);
    for (const rule of matching) await this.executeRule(rule, event);
    return matching.length;
  }

  async enqueue(event: GatewayEvent, rules?: Rule[]) {
    const matching = rules ?? await this.matchingRules(event);
    const now = new Date(this.#now()).toISOString();
    for (const rule of matching) await this.#store.enqueueRuleJob({ id: randomId("rjb"), ruleId: rule.id,
      eventId: event.id, attempt: 0, state: "pending", availableAt: now, createdAt: now });
    return matching.length;
  }

  async executeRule(rule: Rule, event: GatewayEvent) {
    const definition = rule.published!;
    const createdAt = new Date(this.#now()).toISOString();
    const execution: RuleExecution = {
      id: randomId("exe"), ruleId: rule.id, eventId: event.id, status: "running", detail: {}, createdAt
    };
    if (!this.#config.hostedCommandsEnabled) {
      await this.#store.recordRuleExecution({ ...execution, status: "skipped",
        detail: { code: "hosted_commands_disabled", reason: "Hosted commands are temporarily disabled by LibertyTools." },
        completedAt: createdAt });
      return;
    }
    if (definition.cooldown) {
      const scopeValue = definition.cooldown.scope === "player" ? playerId(event)
        : definition.cooldown.scope === "command" ? commandName(event) : event.serverId ?? event.connectionId;
      const cooldown = await this.#store.takeCooldown(`rule:${rule.id}:${definition.cooldown.scope}:${scopeValue}`,
        definition.cooldown.durationMs, this.#now());
      if (!cooldown.allowed) {
        await this.#store.recordRuleExecution({ ...execution, status: "skipped", detail: { reason: "cooldown", retryAfterMs: cooldown.retryAfterMs }, completedAt: createdAt });
        return;
      }
    }
    const connection = await this.#store.getConnection(event.connectionId);
    if (!connection?.encryptedServerKey) {
      await this.#store.recordRuleExecution({ ...execution, status: "failed", detail: { code: "credential_invalid" }, completedAt: createdAt });
      return;
    }
    const serverKey = decryptSecret(connection.encryptedServerKey, this.#config.encryptionKey);
    const username = await this.#resolveUsername(event, serverKey);
    if (!username && definition.actions.some(action => action.type === "privateReply")) {
      await this.#store.recordRuleExecution({ ...execution, status: "failed", detail: { code: "player_not_found" }, completedAt: createdAt });
      return;
    }
    const results: Array<Record<string, unknown>> = [];
    for (const action of definition.actions) {
      const providerRetryAfterMs = await this.#store.remainingCooldown(`erlc:provider:${connection.id}`, this.#now());
      if (providerRetryAfterMs > 0) {
        await this.#store.recordRuleExecution({ ...execution, status: "rateLimited",
          detail: { code: "rate_limited", retryAfterMs: providerRetryAfterMs }, completedAt: new Date(this.#now()).toISOString() });
        return;
      }
      const commandSlot = await this.#store.takeCooldown(`erlc:command:${connection.id}`,
        RUNTIME_LIMITS.erlcCommandMinimumIntervalMs, this.#now());
      if (!commandSlot.allowed) {
        await this.#store.recordRuleExecution({ ...execution, status: "rateLimited",
          detail: { code: "rate_limited", retryAfterMs: commandSlot.retryAfterMs }, completedAt: new Date(this.#now()).toISOString() });
        return;
      }
      if (action.type === "announce") {
        const announcementSlot = await this.#store.takeCooldown(`erlc:announcement:${connection.id}`,
          RUNTIME_LIMITS.erlcAnnouncementMinimumIntervalMs, this.#now());
        if (!announcementSlot.allowed) {
          await this.#store.recordRuleExecution({ ...execution, status: "rateLimited",
            detail: { code: "announcement_rate_limited", retryAfterMs: announcementSlot.retryAfterMs },
            completedAt: new Date(this.#now()).toISOString() });
          return;
        }
      }
      const budgets = await Promise.all([
        this.#store.takeRateLimit(`actions:connection:${connection.id}:minute`, RUNTIME_LIMITS.hostedActionsPerConnectionMinute, 60_000, this.#now()),
        this.#store.takeRateLimit(`actions:account:${connection.accountId}:minute`, RUNTIME_LIMITS.hostedActionsPerAccountMinute, 60_000, this.#now()),
        this.#store.takeRateLimit(`actions:connection:${connection.id}:day`, RUNTIME_LIMITS.hostedActionsPerConnectionDay, 24 * 60 * 60_000, this.#now()),
        this.#store.takeRateLimit(`actions:account:${connection.accountId}:day`, RUNTIME_LIMITS.hostedActionsPerAccountDay, 24 * 60 * 60_000, this.#now())
      ]);
      const blockedBudget = budgets.find(value => !value.allowed);
      if (blockedBudget) {
        const disabledRule = { ...rule, enabled: false, updatedAt: new Date(this.#now()).toISOString() };
        await this.#store.updateRule(disabledRule);
        await this.#store.recordRuleExecution({ ...execution, status: "rateLimited",
          detail: { code: "safety_limit_reached", circuitBreaker: true, retryAfterMs: blockedBudget.retryAfterMs,
            reason: "This command was disabled after reaching a hosted-action safety limit." },
          completedAt: new Date(this.#now()).toISOString() });
        return;
      }
      const command = this.#commandForAction(action, event, username);
      const outcome = await this.#sendCommand(serverKey, command);
      if (!outcome.success) {
        if (outcome.status === 429) {
          await this.#store.setCooldown(`erlc:provider:${connection.id}`,
            outcome.retryAfterMs ?? RUNTIME_LIMITS.erlcCommandMinimumIntervalMs, this.#now());
        }
        if (outcome.status === 401 || outcome.status === 403) {
          const { encryptedServerKey: _encrypted, serverKeyFingerprint: _fingerprint, ...withoutCredential } = connection;
          await this.#store.updateConnection({ ...withoutCredential, updatedAt: new Date(this.#now()).toISOString() });
          outcome.credentialDisabled = true;
        }
        if ([400, 404].includes(outcome.status ?? 0)) {
          await this.#store.setCooldown(`erlc:provider:${connection.id}`, 60_000, this.#now());
        }
        results.push({ type: action.type, ...outcome });
        const status = outcome.status === 429 ? "rateLimited" : outcome.uncertain ? "uncertain" : "failed";
        await this.#store.recordRuleExecution({ ...execution, status, detail: { actions: results }, completedAt: new Date(this.#now()).toISOString() });
        return;
      }
      results.push({ type: action.type, ...outcome });
    }
    await this.#store.recordRuleExecution({ ...execution, status: "succeeded", detail: { actions: results }, completedAt: new Date(this.#now()).toISOString() });
  }

  #commandForAction(action: RuleAction, event: GatewayEvent, username: string) {
    const message = renderTemplate(action.message, event, username);
    return action.type === "privateReply" ? `:pm ${username} ${message}` : `:h ${message}`;
  }

  async #resolveUsername(event: GatewayEvent, serverKey: string) {
    const direct = typeof event.data.username === "string" && /^[A-Za-z0-9_]+$/.test(event.data.username)
      ? event.data.username : "";
    if (direct) return direct;
    const id = playerId(event);
    if (!id) return "";
    try {
      const response = await this.#fetch(`${this.#config.erlcApiBaseUrl}/server?Players=true`, {
        headers: { "server-key": serverKey }
      });
      if (!response.ok) return "";
      const data = await response.json() as { Players?: Array<Record<string, unknown>> };
      for (const player of data.Players ?? []) {
        const combined = player.Player;
        if (typeof combined === "string" && combined.includes(":")) {
          const separator = combined.lastIndexOf(":");
          if (combined.slice(separator + 1) === id) {
            const username = combined.slice(0, separator);
            if (/^[A-Za-z0-9_]+$/.test(username)) return username;
          }
        }
      }
    } catch {}
    return "";
  }

  async #sendCommand(serverKey: string, command: string): Promise<CommandOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#config.forwardTimeoutMs);
    try {
      const response = await this.#fetch(`${this.#config.erlcApiBaseUrl}/server/command`, {
        method: "POST", headers: { "content-type": "application/json", "server-key": serverKey },
        body: JSON.stringify({ command }), signal: controller.signal
      });
      if (response.ok) return { success: true, status: response.status };
      const responseText = await response.text().catch(() => "");
      let providerCode: number | undefined;
      let retryAfterMs: number | undefined;
      let message = responseText.slice(0, 300);
      try {
        const providerError = JSON.parse(responseText) as { code?: unknown; message?: unknown; retry_after?: unknown };
        if (typeof providerError.code === "number") providerCode = providerError.code;
        if (typeof providerError.message === "string") message = providerError.message.slice(0, 300);
        if (typeof providerError.retry_after === "number" && Number.isFinite(providerError.retry_after)) {
          retryAfterMs = Math.max(0, providerError.retry_after * 1000);
        }
      } catch {}
      if (response.status === 429) {
        const retryAfter = response.headers.get("retry-after");
        if (retryAfter) {
          const seconds = Number(retryAfter);
          const dateMs = Date.parse(retryAfter);
          if (Number.isFinite(seconds)) retryAfterMs = Math.max(0, seconds * 1000);
          else if (Number.isFinite(dateMs)) retryAfterMs = Math.max(0, dateMs - this.#now());
        }
      }
      return {
        success: false,
        status: response.status,
        code: response.status === 429 ? "rate_limited" : "erlc_rejected",
        ...(providerCode !== undefined ? { providerCode } : {}),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        ...(message ? { message } : {})
      };
    } catch (error) {
      return { success: false, uncertain: true, code: error instanceof Error ? error.name : "network_error" };
    } finally {
      clearTimeout(timer);
    }
  }
}

export class RuleWorker {
  readonly #store: GatewayStore;
  readonly #engine: RuleEngine;
  readonly #pollMs: number;
  #timer: NodeJS.Timeout | undefined;
  #running = false;

  constructor(options: { store: GatewayStore; engine: RuleEngine; pollMs: number }) {
    this.#store = options.store; this.#engine = options.engine; this.#pollMs = options.pollMs;
  }

  start() {
    if (this.#timer) return;
    this.#timer = setInterval(() => { void this.runOnce(); }, this.#pollMs);
    this.#timer.unref();
  }

  stop() { if (this.#timer) clearInterval(this.#timer); this.#timer = undefined; }

  async runOnce() {
    if (this.#running) return 0;
    this.#running = true;
    try {
      const jobs = await this.#store.claimRuleJobs(10, new Date().toISOString());
      for (const job of jobs) {
        const rule = await this.#store.getRule(job.ruleId);
        const event = await this.#store.getEvent(job.eventId);
        if (!rule?.enabled || !rule.published || !event) {
          await this.#store.updateRuleJob({ ...job, state: "cancelled", lastErrorCode: "rule_or_event_inactive" });
          continue;
        }
        try {
          await this.#engine.executeRule(rule, event);
          await this.#store.updateRuleJob({ ...job, attempt: job.attempt + 1, state: "succeeded" });
        } catch (error) {
          const attempt = job.attempt + 1;
          const retry = attempt < 3;
          await this.#store.updateRuleJob({ ...job, attempt, state: retry ? "pending" : "failed",
            availableAt: retry ? new Date(Date.now() + attempt * 1000).toISOString() : new Date().toISOString(),
            lastErrorCode: error instanceof Error ? error.name : "rule_execution_failed" });
        }
      }
      return jobs.length;
    } finally { this.#running = false; }
  }
}
