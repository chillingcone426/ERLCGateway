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
- Response: `204 No Content` on success

Example:

```bash
curl -i -X POST http://localhost:3000/webhook/create \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your_webhook_created_auth_token" \
  -d '{"discordID":"1234567890","webhookURL": "website", "mode": "poll, easy, proxy"}'
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
- `V1_API_BASE_URL` (currently loaded but not required for current endpoints)
- `V1_SERVER_KEY` (currently loaded but not required for current endpoints)
