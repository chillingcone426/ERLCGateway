# Liberty Tools Gateway

The v2 gateway accepts one signed ER:LC webhook per connection and fans each event out to independent Poll clients, hosted command rules, signed Proxy destinations, and raw mirrors.

## Local setup

1. Create a PostgreSQL database.
2. Copy `.env.example` to `.env` and set `DATABASE_URL`, `MANAGEMENT_API_TOKEN`, and `SECRET_ENCRYPTION_KEY_BASE64`.
3. Run `npm ci`, then `npm run dev`.

Migrations in `migrations/` run in filename order when the service starts. The service exposes `/health/live` and `/health/ready`.

## Security model

- Incoming events must carry a valid ER:LC Ed25519 signature over the exact timestamp and raw request bytes.
- Destination URLs may use HTTP or HTTPS, including public IP addresses. Loopback, private, link-local, metadata, and internal DNS results are blocked. Redirects are not followed.
- Signed Proxy requests include `x-liberty-timestamp` and `x-liberty-signature`. Raw Mirror requests preserve the original ER:LC body and signature headers.
- New destinations begin in probation. Any successful 2xx response activates them. Five consecutive probation failures or ten consecutive established failures pause delivery.
- Hosted actions require an encrypted ER:LC server key and run through a durable worker with cooldown and account budgets.

## Main API flow

The dashboard sends `Authorization: Bearer <MANAGEMENT_API_TOKEN>` and an account identity in `x-liberty-account-id` to management endpoints.

1. `POST /v1/management/connections`
2. Put the returned `ingestUrl` in ER:LC.
3. Add any combination of Poll subscriptions, destinations, and hosted rules below that connection.
4. Poll consumers use the one-time token at `/v1/poll/subscriptions/:id/events` and acknowledge completed event IDs.

Run `npm run check` for the TypeScript build and test suite.
