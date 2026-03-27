const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const express = require('express');
const dotenv = require('dotenv');
const { MongoClient } = require("mongodb");
function generateWebhookId() {
  return crypto.randomBytes(12).toString("base64url");
}

const DEFAULT_PUBLIC_KEY_BASE64 = 'MCowBQYDK2VwAyEAjSICb9pp0kHizGQtdG8ySWsDChfGqi+gyFCttigBNOA=';
const DEFAULT_V1_API_BASE_URL = 'https://api.policeroleplay.community/v1';

dotenv.config();

const port = process.env.PORT || 3000;
const publicKeyBase64 = process.env.PUBLIC_KEY_BASE64 || DEFAULT_PUBLIC_KEY_BASE64;
const v1ApiBaseUrl = process.env.V1_API_BASE_URL || DEFAULT_V1_API_BASE_URL;
const v1ServerKey = process.env.V1_SERVER_KEY;
const webhookCreatedAuthToken = process.env.WEBHOOK_CREATED_AUTH_TOKEN || 'your_webhook_created_auth_token';
const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017';
const mongoDbName = process.env.MONGO_DB_NAME || 'erlc_gateway';

const COLLECTION_FORMATS = {
  webhooks: {
    description: 'Stores webhook registrations.',
    requiredFields: {
      webhookId: 'string',
      robloxID: 'string',
      username: 'string',
      mode: 'string (poll|easy|proxy)',
      createdAt: 'date'
    },
    optionalFields: {
      webhookURL: 'string (optional when mode is poll)'
    },
    indexes: [
      { fields: { webhookId: 1 }, unique: true }
    ]
  },
  webhookEvents: {
    description: 'Stores queued poll events.',
    requiredFields: {
      webhookId: 'string',
      event: 'string',
      userId: 'string',
      timestamp: 'string|number',
      createdAt: 'date'
    },
    optionalFields: {
      server: 'object',
      eventData: 'flattened from ERLC event.data keys'
    },
    indexes: [
      { fields: { createdAt: 1 }, ttlSeconds: 600 }
    ]
  }
};

function verifySignature(timestamp, rawBody, signatureHex, publicKey) {
  const signature = Buffer.from(signatureHex, 'hex');
  const message = Buffer.concat([Buffer.from(timestamp, 'utf8'), rawBody]);

  return crypto.verify(null, message, publicKey, signature);
}

const publicKey = crypto.createPublicKey({
    key: Buffer.from(publicKeyBase64, 'base64'),
    format: 'der',
    type: 'spki',
  });

function reject(res, status, reason, extra = {}) {
  console.warn('[ERLC webhook] rejected request', {
    status,
    reason,
    ...extra,
  });

  return res.status(status).json({ error: reason });
}

function isTimestampFresh(timestampString, maxSkewSeconds) {
  if (!/^\d+$/.test(timestampString)) {
    return false; //invalid timestamp format
  }

  const requestTs = Number(timestampString); //convert to number
  const nowTs = Math.floor(Date.now() / 1000); //find current timestamp
  const skew = Math.abs(nowTs - requestTs); //calculate time difference

  return skew <= maxSkewSeconds;
}

function validateWebhookPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: 'Payload must be a JSON object' };
  }

  if (!Array.isArray(body.events) || body.events.length === 0) {
    return { ok: false, reason: 'Payload must include a non-empty events array' };
  }

  for (let i = 0; i < body.events.length; i += 1) {
    const event = body.events[i];
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      return { ok: false, reason: `events[${i}] must be an object` };
    }

    if (typeof event.event !== 'string' || event.event.trim() === '') {
      return { ok: false, reason: `events[${i}].event must be a non-empty string` };
    }

    if (typeof event.origin !== 'string' || event.origin.trim() === '') {
      return { ok: false, reason: `events[${i}].origin must be a non-empty string` };
    }

    if (typeof event.timestamp !== 'number' && typeof event.timestamp !== 'string') {
      return { ok: false, reason: `events[${i}].timestamp must be a string or number` };
    }

    if (event.data !== undefined && (typeof event.data !== 'object' || event.data === null || Array.isArray(event.data))) {
      return { ok: false, reason: `events[${i}].data must be an object when provided` };
    }
  }

  return { ok: true };
}

const receivedEvents = []; //debug store for received events

const app = express();

const mongoClient = new MongoClient(mongoUri);
let webhooks;
let webhookEvents;

async function connectMongo() {
  await mongoClient.connect();

  const db = mongoClient.db(mongoDbName);
  webhooks = db.collection('webhooks');
  webhookEvents = db.collection('webhookEvents');

  await webhooks.createIndex({ webhookId: 1 }, { unique: true });
  await webhookEvents.createIndex({ createdAt: 1 }, { expireAfterSeconds: 600 });

  console.log(`[MongoDB] connected to ${mongoDbName}`);
}

app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'erlc-webhook-test-service' });
  });

app.get('/meta/collections-format', (_req, res) => {
  res.json({
    database: mongoDbName,
    collections: COLLECTION_FORMATS
  });
});


app.get("/webhooks", async (req, res) => {
  try {
    const authHeader = req.header('Authorization');
    if (authHeader !== `Bearer ${webhookCreatedAuthToken}`) {
      console.warn('Received /webhook/create with invalid Authorization header:', authHeader);
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const data = await webhooks
      .find({})
      .sort({ createdAt: -1 }) // newest first
      .toArray();

    res.json({
      count: data.length,
      webhooks: data
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error" });
  }
});

app.delete("/webhook/:id", express.json(), async (req, res) => {
  try {
    const authHeader = req.header('Authorization');
    if (authHeader !== `Bearer ${webhookCreatedAuthToken}`) {
      console.warn('Received /webhook/create with invalid Authorization header:', authHeader);
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const result = await webhooks.deleteOne({
      webhookId: req.params.id
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        error: "Webhook not found"
      });
    }

    res.json({
      success: true,
      deleted: req.params.id
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error" });
  }
});

app.post('/webhook/create', express.json(), async (req, res) => {
    try {
    const authHeader = req.header('Authorization');
    if (authHeader !== `Bearer ${webhookCreatedAuthToken}`) {
      console.warn('Received /webhook/create with invalid Authorization header:', authHeader);
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!req.body || typeof req.body !== 'object') {
      console.warn('Received /webhook/create with invalid body:', req.body);
      return res.status(400).json({ error: 'Invalid JSON body' });
    }

    const { robloxID, username, webhookURL, mode } = req.body;
    if (!robloxID || !mode || typeof username !== 'string' || username.trim() === '') {
      console.warn('Received /webhook/create with missing robloxID or mode or username:', req.body);
      return res.status(400).json({ error: 'Missing robloxID or mode or username' });
    }

    const normalizedMode = String(mode).trim().toLowerCase();
    if (!['poll', 'easy', 'proxy'].includes(normalizedMode)) {
      return res.status(400).json({ error: 'Invalid mode. Use poll, easy, or proxy' });
    }

    if (normalizedMode !== 'poll' && !webhookURL) {
      return res.status(400).json({ error: 'webhookURL is required for easy and proxy modes' });
    }

    const webhookId = generateWebhookId();

    await webhooks.insertOne({
      webhookId,
      robloxID,
      username: username.trim(),
      ...(webhookURL ? { webhookURL } : {}),
      mode: normalizedMode,
      createdAt: new Date()
    });



  console.log(`Received /webhook/create for Roblox ID ${robloxID}`);
    console.log('Received /webhook/create event with body:', req.body);
    res.json({
      success: true,
      webhookId,
      endpoint: `/webhook/${webhookId}`
    });

    }catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error" });
  } 
  });  

  app.patch("/webhook/:id", express.json(),async (req, res) => {
  try {
    const authHeader = req.header('Authorization');
    if (authHeader !== `Bearer ${webhookCreatedAuthToken}`) {
      console.warn('Received /webhook/create with invalid Authorization header:', authHeader);
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { webhookURL, mode, robloxID, username } = req.body;

    const existingWebhook = await webhooks.findOne({ webhookId: req.params.id });
    if (!existingWebhook) {
      return res.status(404).json({
        error: "Webhook not found"
      });
    }

    const nextMode = mode !== undefined
      ? String(mode).trim().toLowerCase()
      : existingWebhook.mode;

    if (!['poll', 'easy', 'proxy'].includes(nextMode)) {
      return res.status(400).json({ error: 'Invalid mode. Use poll, easy, or proxy' });
    }

    const nextWebhookURL = webhookURL !== undefined ? webhookURL : existingWebhook.webhookURL;
    if (nextMode !== 'poll' && !nextWebhookURL) {
      return res.status(400).json({ error: 'webhookURL is required for easy and proxy modes' });
    }

    const update = {};

    if (webhookURL !== undefined) update.webhookURL = webhookURL;
    if (mode !== undefined) update.mode = nextMode;
    if (robloxID !== undefined) update.robloxID = robloxID;
    if (username !== undefined) {
      if (typeof username !== 'string' || username.trim() === '') {
        return res.status(400).json({ error: 'username must be a non-empty string' });
      }
      update.username = username.trim();
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({
        error: "Nothing to update"
      });
    }

    console.log(`Received /webhook/${req.params.id} update with body:`, req.body);

    const result = await webhooks.findOneAndUpdate(
      { webhookId: req.params.id },
      { $set: update },
      { returnDocument: "after" }
    );

    if (!result.value) {
      return res.status(404).json({
        error: "Webhook not found"
      });
    }

    res.json({
      success: true,
      webhook: result.value
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error" });
  }
});

app.get("/webhook/:id/events", async (req, res) => {
  try {
    // check webhook exists
    const webhook = await webhooks.findOne({
      webhookId: req.params.id
    });

    if (!webhook) {
      return res.status(404).json({
        error: "Webhook not found"
      });
    }

    // check correct mode
    if (webhook.mode !== "poll") {
      return res.status(400).json({
        error: "Webhook is not in poll mode",
        mode: webhook.mode
      });
    }

    // fetch events
    const events = await webhookEvents
      .find({ webhookId: req.params.id })
      .sort({ createdAt: 1 })
      .limit(50)
      .toArray();

    // return first
    res.json({
      count: events.length,
      events
    });

    // then delete (queue behavior)
    if (events.length > 0) {
      await webhookEvents.deleteMany({
        _id: { $in: events.map(e => e._id) }
      });
    }

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error" });
  }
});

app.use(express.raw({ type: () => true, limit: '2mb' })); //parse body as raw bytes for signature verification

app.post('/webhook/erlc/:id', async (req, res) => {
    const webhook = await webhooks.findOne({
      webhookId: req.params.id
    });

    if (!webhook) {
      return reject(res, 404, 'Webhook not found.');
    }

    const timestamp = req.header('X-Signature-Timestamp');
    const signatureHex = req.header('X-Signature-Ed25519');
    const contentType = req.header('Content-Type');

    if (!Buffer.isBuffer(req.body)) {
      return reject(res, 400, 'Body must be raw bytes.', { contentType });
    }

    if (!timestamp || !signatureHex) {
      return reject(res, 400, 'Missing required headers');
    }

    if (!/^\d+$/.test(timestamp)) {
      return reject(res, 400, 'Timestamp must be unix');
    }

    if (!isTimestampFresh(timestamp, 300)) {
      return reject(res, 400, 'Timestamp expired');
    }

    if (!/^[a-fA-F0-9]+$/.test(signatureHex)) {
      return reject(res, 400, 'Invalid signature format');
    }

    let valid;
    try {
      valid = verifySignature(timestamp, req.body, signatureHex, publicKey);
    } catch (err) {
      return reject(res, 400, 'Malformed signature');
    }

    if (!valid) {
      return reject(res, 401, 'Invalid signature.');
    }

    // ✅ only parse AFTER validation
    let body;
    try {
      body = JSON.parse(req.body.toString('utf8'));
    } catch {
      return reject(res, 400, 'Invalid JSON');
    }

    const payloadValidation = validateWebhookPayload(body);
    if (!payloadValidation.ok) {
      return reject(res, 400, payloadValidation.reason);
    }

    // -------------------------
    // MODES (only valid requests reach here)
    // -------------------------

    if (webhook.mode === "proxy") {
      console.log(`[ERLC webhook] proxy → ${webhook.webhookURL}`);

      let proxyResponse;
      try {
        proxyResponse = await fetch(webhook.webhookURL, {
          method: "POST",
          headers: {
            "Content-Type": req.headers["content-type"],
            "X-Signature-Timestamp": timestamp,
            "X-Signature-Ed25519": signatureHex
          },
          body: req.body
        });
      } catch (err) {
        console.error('[ERLC webhook] proxy delivery failed', err);
        return reject(res, 502, 'Proxy delivery failed');
      }

      if (!proxyResponse.ok) {
        return reject(res, 502, `Proxy endpoint rejected request (${proxyResponse.status})`);
      }
    }

    else if (webhook.mode === "easy") {
      const e = body.events?.[0];

      const easyPayload = {
        event: e?.event,
        userId: e?.origin,
        timestamp: e?.timestamp,
        ...e?.data,
        server: body.server
      };

      let easyResponse;
      try {
        easyResponse = await fetch(webhook.webhookURL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(easyPayload)
        });
      } catch (err) {
        console.error('[ERLC webhook] easy delivery failed', err);
        return reject(res, 502, 'Easy delivery failed');
      }

      if (!easyResponse.ok) {
        return reject(res, 502, `Easy endpoint rejected request (${easyResponse.status})`);
      }
    }

    else if (webhook.mode === "poll") {

  const events = body.events.map(e => ({
    webhookId: webhook.webhookId,
    event: e.event,
    userId: e.origin,
    timestamp: e.timestamp,
    ...e.data,
    server: body.server,
    createdAt: new Date()
  }));

  await webhookEvents.insertMany(events);

  // keep only newest 50
  const overflow = await webhookEvents
    .find({ webhookId: webhook.webhookId })
    .sort({ createdAt: -1 })
    .skip(50)
    .toArray();

  if (overflow.length > 0) {
    await webhookEvents.deleteMany({
      _id: { $in: overflow.map(e => e._id) }
    });
  }
}
    else {
      return reject(res, 400, `Unsupported webhook mode: ${webhook.mode}`);
    }

    return res.sendStatus(204);
});

async function boot() {
  try {
    await connectMongo();
    app.listen(port, "0.0.0.0", () => {
      console.log(`Server is running on port ${port}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

boot();
