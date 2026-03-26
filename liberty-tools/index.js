export default class LibertyTools {
    constructor({ SERVER_KEY, PRIVATE_SERVER_API = "https://api.policeroleplay.community/v2/", WEBHOOK_URL, WEBHOOK_TOKEN  } = {}) {
        if (!SERVER_KEY) {
            throw new Error("[LibertyTools]: SERVER_KEY is required");
        }

        this.SERVER_KEY = SERVER_KEY;
        this.PRIVATE_SERVER_API = PRIVATE_SERVER_API;

        if (WEBHOOK_URL && !WEBHOOK_TOKEN) {
            throw new Error("[LibertyTools]: WEBHOOK_TOKEN is required if you are using a webhook");
        }

        this.useWebhook = !!WEBHOOK_URL;

        if (WEBHOOK_URL && WEBHOOK_TOKEN) {
            this.WEBHOOK_URL = WEBHOOK_URL;
            this.WEBHOOK_TOKEN = WEBHOOK_TOKEN;
        }

        this.rateLimits = {
            get: { limit: null, remaining: null, reset: null },
            post: { limit: null, remaining: null, reset: null }
        };

        this.resStatus = {
            forbiddenErrors: 0
        };
    }

    #wait(seconds) {
        return new Promise(r => setTimeout(r, seconds * 1000));
    }

    async #fetchAPI(url, o = {}) {
        if (!this.SERVER_KEY) {
            return {
                error: "invalid_env",
                message: "[fetchAPI]: SERVER_KEY was not provided in a .env file"
            };
        }
        if (this.resStatus.forbiddenErrors >= 2) {
            return {
                error: "forbidden",
                message: "[fetchAPI]: Received a 403 error 2 times, suspending API calls as the server key may be invalid"
            };
        }

        const isPRC = url.startsWith("https://api.policeroleplay.community/");
        
        const method = (o.method || "GET").toUpperCase();

        let headers = { ...(o.headers || {}) };

        // construct body for POST requests IF its a prc endpoint
        let body = o.body;
        if (method === "POST" && body !== undefined && isPRC) {
            headers["Content-Type"] = "application/json";
            body = JSON.stringify(body);
        }

        if (isPRC) headers["server-key"] = this.SERVER_KEY;

        const res = await fetch(url, {
            ...o,
            method,
            headers,
            body
        });

        const d = await res.json();

        if (!res.ok) {
            if (res.status === 403) this.resStatus.forbiddenErrors++;
            return {
                error: "api-error",
                message: `[fetchAPI]: Encountered an error while attempting to fetch ${url}`,
                apiResponse: d
            }
        } else {
            if (isPRC) {
                const target = method === "GET"
                    ? this.rateLimits.get
                    : this.rateLimits.post;

                target.reset = Number(res.headers.get("X-RateLimit-Reset"));
                target.limit = Number(res.headers.get("X-RateLimit-Limit"));
                target.remaining = Number(res.headers.get("X-RateLimit-Remaining"));
            }
            return d;
        }
    }

    async getPrivateServerAPI(query) {
        const url = this.PRIVATE_SERVER_API + "server" + (query ?? "");

        const currentTime =  Math.floor(Date.now() / 1000); // convert ms to seconds

        const rl = this.rateLimits.get;
        if (rl.reset && rl.remaining === 0 && currentTime < rl.reset) {
            const seconds = Math.max(0, rl.reset - currentTime);
            console.log(`[getPrivateServerAPI]: You are currently being rate limited! Sending request in ${seconds} seconds`);
            await this.#wait(seconds);
        }
        return this.#fetchAPI(url);
    }

    async sendPrivateServerCommand(command) {
        const url = this.PRIVATE_SERVER_API + "server/command";

        const currentTime =  Math.floor(Date.now() / 1000); // convert ms to seconds

        if (!command || typeof command !== "object") {
            return {
                error: "invalid_object",
                message: "[sendPrivateServerCommand]: You must include a valid object"
            };
        }

        if (Object.keys(command).length > 1) {
            return {
                error: "too_many_objects",
                message: "[sendPrivateServerCommand]: You may only send one command at a time",
            };
        } else {
            if (Object.keys(command)[0] !== "command") {
                return {
                    error: "invalid_object",
                    message: '[sendPrivateServerCommand]: Object key must start with "command"',
                };
            }
        }

        const rl = this.rateLimits.post;
        if (rl.reset && rl.remaining === 0 && currentTime < rl.reset) {
            const seconds = Math.max(0, rl.reset - currentTime);
            console.log(`[sendPrivateServerCommand]: You are currently being rate limited! Sending request in ${seconds} seconds`);
            await this.#wait(seconds);
        }
        return this.#fetchAPI(url, { method: "POST", body: command });
    }

    async fetchWebhookEvents() {
        if (!this.useWebhook) {
            return {
                error: "webhook_disabled",
                message: "[fetchWebhookEvents]: Webhook is not configured"
            };
        }

        if (!this.WEBHOOK_URL || !this.WEBHOOK_TOKEN) {
            return {
                error: "invalid_env",
                message: "[fetchWebhookEvents]: You must provide a WEBHOOK_URL and/or a WEBHOOK_TOKEN in a .env file"
            };
        }

        const url = this.WEBHOOK_URL + "webhook/" + String(this.WEBHOOK_TOKEN) + "/events";
        const r = await fetch(url, {
            method: "GET"
        });

        const d = await r.json();

        if (r.ok) {
            return d;
        } else {
            return {
                error: "api-error",
                message: `[fetchWebhookEvents]: Encountered an error while attempting to fetch ${url}`,
                apiResponse: d
            };
        }
    }
}