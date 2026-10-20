#!/usr/bin/env python3
"""Read a deployment token or Discord webhook without echoing it to the terminal."""

import getpass
import os
import sys
from pathlib import Path

root = Path("/home/thebeston123/liberty-v2-production/shared")
kind = sys.argv[1] if len(sys.argv) == 2 else ""
if kind == "github":
    target = root / "github-read-token"
    prompt = "GitHub fine-grained read-only token (Dashboard Contents + Actions): "
elif kind == "discord":
    target = root / "ops-discord-webhook"
    prompt = "Discord operator-alert webhook URL: "
else:
    raise SystemExit("Usage: install-private-value.py github|discord")

value = getpass.getpass(prompt).strip()
if kind == "github" and (len(value) < 30 or any(char.isspace() for char in value)):
    raise SystemExit("That does not look like a GitHub token; nothing was saved")
if kind == "discord" and not value.startswith(("https://discord.com/api/webhooks/", "https://discordapp.com/api/webhooks/")):
    raise SystemExit("That does not look like a Discord webhook URL; nothing was saved")

temporary = target.with_suffix(".tmp")
descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(descriptor, "w") as output:
    output.write(value + "\n")
os.replace(temporary, target)
target.chmod(0o600)
print(f"Saved {kind} value privately; content was not displayed")
