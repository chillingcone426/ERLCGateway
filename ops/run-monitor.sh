#!/usr/bin/env bash
set -euo pipefail
root=/home/thebeston123/liberty-v2-production
if [[ ! -s "$root/shared/ops-discord-webhook" ]]; then exit 0; fi
set -a
. "$root/shared/gateway.env"
DISCORD_ALERT_WEBHOOK_URL="$(cat "$root/shared/ops-discord-webhook")"
OPS_MONITOR_STATE_PATH="$root/shared/ops-monitor-state.json"
export DISCORD_ALERT_WEBHOOK_URL OPS_MONITOR_STATE_PATH
cd "$root/gateway"
node dist/src/ops-monitor.js
