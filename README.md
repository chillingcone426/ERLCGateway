# LibertyTools API

This service exposes webhook endpoints for ERLC events plus a health check.

## Base URL

- Local: `http://localhost:3000`
- Port is configurable with `PORT` in `.env`.

## Authentication

### `/webhook/create`

- Requires header: `Authorization: Bearer <WEBHOOK_CREATED_AUTH_TOKEN>`
- If token is missing or invalid, returns `401 Unauthorized`.

### `/webhook/erlc`

- Requires signature headers:
  - `X-Signature-Timestamp` (unix timestamp string)
  - `X-Signature-Ed25519` (hex signature)
- Body must be the raw JSON bytes (used for signature verification).

## Endpoints

### `GET /health`

Health check endpoint.

- Response: `200 OK`

```json
{
  "ok": true,
  "service": "erlc-webhook-test-service"
}
```

### `POST /webhook/create`

Receives a JSON payload and logs it.

- Headers:
  - `Content-Type: application/json`
  - `Authorization: Bearer <WEBHOOK_CREATED_AUTH_TOKEN>`
- Body rules:
  - `robloxID` is required
  - `username` is required and must be a non-empty string
  - `mode` is required: `poll`, `easy`, or `proxy`
  - `webhookURL` is optional for `poll`, required for `easy` and `proxy`
- Response: `204 No Content` on success

Example:

```bash
curl -i -X POST http://localhost:3000/webhook/create \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your_webhook_created_auth_token" \
  -d '{"robloxID":"1234567890","username":"example_user","mode":"poll"}'
```

### `POST /webhook/erlc`

Verifies request signature, parses JSON body, and accepts event.

- Headers:
  - `Content-Type: application/json`
  - `X-Signature-Timestamp: <unix_timestamp>`
  - `X-Signature-Ed25519: <hex_signature>`
- Response: `204 No Content` on success

Common error responses:

- `400` Missing/invalid headers, invalid body, malformed signature input, stale timestamp
- `401` Invalid signature

## Environment Variables

- `PORT` (default: `3000`)
- `PUBLIC_KEY_BASE64` (Ed25519 public key, base64-encoded DER/SPKI)
- `WEBHOOK_CREATED_AUTH_TOKEN` (Bearer token for `/webhook/create`)
- `MONGO_URI` (default: `mongodb://127.0.0.1:27017`)
- `MONGO_DB_NAME` (default: `erlc_gateway`)
- `V1_API_BASE_URL` (currently loaded but not required for current endpoints)
- `V1_SERVER_KEY` (currently loaded but not required for current endpoints)

## MongoDB

The service stores webhook configs and queued events in MongoDB.

- Connection string in code: `mongodb://127.0.0.1:27017`
- Database name: `erlc_gateway`
- Collections:
  - `webhooks`: webhook registrations
  - `webhookEvents`: queued poll-mode events

### Indexes

- `webhooks.webhookId` unique index
- `webhookEvents.createdAt` TTL index (`expireAfterSeconds: 600`), so events expire after 10 minutes

### Collection Format Reference

See `docs/mongodb-collections-format.md` for field-by-field formats and example documents.

You can also fetch format metadata from the running API:

- `GET /meta/collections-format`
