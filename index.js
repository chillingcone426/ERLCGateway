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
    console.warn('[ERLC webhook] rejected request', { //console log info on rejected request
      status,
      reason,
      ...extra,
    });
    return res.status(status).json({ error: reason }); //simply just return the data as needed
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

const receivedEvents = []; //debug store for received events

const app = express();

const client = new MongoClient("mongodb://127.0.0.1:27017"); //temp for testing

async function start() {
  await client.connect();

  const db = client.db("erlc_gateway");
  webhooks = db.collection("webhooks");

  await webhooks.createIndex({ webhookId: 1 }, { unique: true });

  console.log("MongoDB connected");
}

start();


app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});

app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'erlc-webhook-test-service' });
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

    if (!req.body.discordID || !req.body.webhookURL || !req.body.mode) {
      console.warn('Received /webhook/create with missing discordID or webhookURL or mode:', req.body);
      return res.status(400).json({ error: 'Missing discordID or webhookURL or mode' });
    }

    const webhookId = generateWebhookId();

    await webhooks.insertOne({
      webhookId,
      discordID: req.body.discordID,
      webhookURL: req.body.webhookURL,
      mode: req.body.mode,
      createdAt: new Date()
    });



    console.log(`Received /webhook/create for Discord ID ${req.body.discordID}`);
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

    const { webhookURL, mode, discordID } = req.body;

    const update = {};

    if (webhookURL !== undefined) update.webhookURL = webhookURL;
    if (mode !== undefined) update.mode = mode;
    if (discordID !== undefined) update.discordID = discordID;

    if (Object.keys(update).length === 0) {
      return res.status(400).json({
        error: "Nothing to update"
      });
    }

    console.log(`Received /webhook/${req.params.id} update with body:`, req.body);

    const find = await webhooks.findOne({ webhookId: req.params.id });

    if (!find) {
        console.warn(`Webhook with ID ${req.params.id} not found for update`);
    }

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

    console.log('[ERLC webhook] received request with headers:', {
      timestamp,
      signatureHex,
      contentType,
      webhookId: req.params.id
    });

    if (!Buffer.isBuffer(req.body)) {
      return reject(res, 400, 'Body must be raw bytes.', { contentType });
    }

    if (!timestamp || !signatureHex) {
      return reject(res, 400, 'Missing required headers: X-Signature-Timestamp and X-Signature-Ed25519.', {
        contentType,
      });
    }

    if (!/^\d+$/.test(timestamp)) {
      return reject(res, 400, 'Timestamp must be a unix timestamp string.', { timestamp });
    }

    if (!isTimestampFresh(timestamp, 300)) {
      return reject(res, 400, 'Timestamp is outside allowed skew window.', {
        timestamp,
        maxTimestampSkewSeconds: 300,
      });
    }

    if (!/^[a-fA-F0-9]+$/.test(signatureHex) || signatureHex.length % 2 !== 0) {
      return reject(res, 400, 'Signature must be valid hex.');
    }

    let valid;
    try {
      valid = verifySignature(timestamp, req.body, signatureHex, publicKey);
    } catch (err) {
      return reject(res, 400, 'Signature verification input is malformed.', { detail: err.message });
    }

    if (!valid) {
      return reject(res, 401, 'Invalid signature.');
    }

    let event;
    try {
      event = JSON.parse(req.body.toString('utf8'));
    } catch (_err) {
      return reject(res, 400, 'Body must be valid JSON.', { contentType });
    }

    const envelope = {
      webhookId: req.params.id,
      receivedAt: new Date().toISOString(),
      timestamp,
      query: req.query,
      event,
    };

    console.log('[ERLC webhook] accepted event');
    console.log(JSON.stringify(envelope, null, 2));

    console.log('[ERLC webhook] raw body:', req.body.toString('utf8'));

    // send to stored webhook
    if (webhook.mode === "proxy") {
        console.log(`[ERLC webhook] forwarding event to ${webhook.webhookURL}`);
      await fetch(webhook.webhookURL, {
  method: "POST",
  headers: {
    "Content-Type": req.headers["content-type"],
    "X-Signature-Timestamp": req.headers["x-signature-timestamp"],
    "X-Signature-Ed25519": req.headers["x-signature-ed25519"]
  },
  body: req.body
}).catch(console.error);
    }

    if (webhook.mode === "easy") {
  const body = JSON.parse(req.body.toString("utf8"));

  const event = body.events?.[0];

  const easyPayload = {
    event: event?.event,
    userId: event?.origin,
    timestamp: event?.timestamp,
    command: event?.data?.command,
    argument: event?.data?.argument,
    server: body.server
  };

  await fetch(webhook.webhookURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(easyPayload)
  }).catch(console.error);
}

    return res.status(204).send();
});
