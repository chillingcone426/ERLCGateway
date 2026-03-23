const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const express = require('express');
const dotenv = require('dotenv');

const DEFAULT_PUBLIC_KEY_BASE64 = 'MCowBQYDK2VwAyEAjSICb9pp0kHizGQtdG8ySWsDChfGqi+gyFCttigBNOA=';
const DEFAULT_V1_API_BASE_URL = 'https://api.policeroleplay.community/v1';

dotenv.config();

const port = process.env.PORT || 3000;
const publicKeyBase64 = process.env.PUBLIC_KEY_BASE64 || DEFAULT_PUBLIC_KEY_BASE64;
const v1ApiBaseUrl = process.env.V1_API_BASE_URL || DEFAULT_V1_API_BASE_URL;
const v1ServerKey = process.env.V1_SERVER_KEY;

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
    return false;
  }

  const requestTs = Number(timestampString);
  const nowTs = Math.floor(Date.now() / 1000);
  const skew = Math.abs(nowTs - requestTs);

  return skew <= maxSkewSeconds;
}

   const receivedEvents = []; //debug store for received events

const app = express();

app.use(express.raw({ type: () => true, limit: '2mb' }));

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});

app.post('/webhook/erlc', async (req, res) => {
    const timestamp = req.header('X-Signature-Timestamp');
    const signatureHex = req.header('X-Signature-Ed25519');
    const contentType = req.header('Content-Type');
    console.log('[ERLC webhook] received request with headers:', {
      timestamp,
      signatureHex,
      contentType,
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
      receivedAt: new Date().toISOString(),
      timestamp,
      query: req.query,
      event,
    };

    receivedEvents.push(envelope);
    if (receivedEvents.length > 1000) {
      receivedEvents.shift();
    }

    console.log('[ERLC webhook] accepted event');
    console.log(JSON.stringify(envelope, null, 2));

    
    console.log('[ERLC webhook] raw body:', req.body.toString('utf8')); //log info
    

    
      //await processAutoReplies(config, event, req.headers, playerResolver, v1RateLimiter);
    

    return res.status(204).send();
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'erlc-webhook-test-service' });
  });