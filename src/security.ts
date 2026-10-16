import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";

export function randomId(prefix: string) {
  return `${prefix}_${crypto.randomBytes(16).toString("base64url")}`;
}

export function createToken(prefix: string) {
  const token = `${prefix}_${crypto.randomBytes(32).toString("base64url")}`;
  return { token, hash: hashToken(token), prefix: token.slice(0, prefix.length + 9) };
}

export function hashToken(token: string) {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

export function constantTimeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function encryptSecret(value: string, key: Buffer) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${nonce.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

export function decryptSecret(value: string, key: Buffer) {
  const [version, nonceValue, tagValue, encryptedValue] = value.split(".");
  if (version !== "v1" || !nonceValue || !tagValue || !encryptedValue) throw new Error("Invalid encrypted secret");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(nonceValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

export function secretFingerprint(value: string) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}

export function verifyErlcSignature(options: {
  rawBody: Buffer;
  timestamp: string;
  signature: string;
  publicKeySpkiBase64: string;
  maxClockSkewSeconds: number;
  now?: number;
}) {
  const { rawBody, timestamp, signature, publicKeySpkiBase64, maxClockSkewSeconds } = options;
  const timestampNumber = Number(timestamp);
  if (!Number.isFinite(timestampNumber)) return false;
  const timestampMs = timestampNumber > 10_000_000_000 ? timestampNumber : timestampNumber * 1000;
  if (Math.abs((options.now ?? Date.now()) - timestampMs) > maxClockSkewSeconds * 1000) return false;
  if (!/^[a-fA-F0-9]+$/.test(signature) || signature.length % 2 !== 0) return false;
  try {
    const publicKey = crypto.createPublicKey({
      key: Buffer.from(publicKeySpkiBase64, "base64"),
      format: "der",
      type: "spki"
    });
    return crypto.verify(
      null,
      Buffer.concat([Buffer.from(timestamp, "utf8"), rawBody]),
      publicKey,
      Buffer.from(signature, "hex")
    );
  } catch {
    return false;
  }
}

function blockedIpv4(address: string) {
  const parts = address.split(".").map(Number);
  const [a = -1, b = -1] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51) ||
    (a === 203 && b === 0);
}

function blockedIpv6(address: string) {
  const normalized = address.toLowerCase();
  return normalized === "::" || normalized === "::1" || normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb") ||
    normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8:") || normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("::ffff:10.") || normalized.startsWith("::ffff:192.168.");
}

export function isBlockedAddress(address: string) {
  const version = net.isIP(address);
  if (version === 4) return blockedIpv4(address);
  if (version === 6) return blockedIpv6(address);
  return true;
}

export interface ValidatedDestination {
  url: URL;
  addresses: string[];
  transportSecurity: "encrypted" | "unencrypted";
}

export async function validateDestinationUrl(
  value: string,
  lookup: typeof dns.lookup = dns.lookup
): Promise<ValidatedDestination> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw Object.assign(new Error("Destination URL is invalid"), { code: "validation_failed" });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw Object.assign(new Error("Destination must use HTTP or HTTPS"), { code: "destination_scheme_invalid" });
  }
  if (url.username || url.password || url.hash) {
    throw Object.assign(new Error("Destination URL cannot include credentials or a fragment"), { code: "validation_failed" });
  }
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (port !== 80 && port !== 443 && (port < 1024 || port > 65535)) {
    throw Object.assign(new Error("Destination port is not allowed"), { code: "destination_blocked" });
  }
  const ipVersion = net.isIP(url.hostname);
  const addresses = ipVersion
    ? [url.hostname]
    : (await lookup(url.hostname, { all: true, verbatim: true })).map(result => result.address);
  if (!addresses.length || addresses.some(isBlockedAddress)) {
    throw Object.assign(new Error("Destination resolves to a blocked network"), { code: "destination_blocked" });
  }
  return {
    url,
    addresses,
    transportSecurity: url.protocol === "https:" ? "encrypted" : "unencrypted"
  };
}

export function signProxyBody(secret: string, timestamp: string, rawBody: Buffer) {
  return crypto.createHmac("sha256", secret).update(timestamp).update(".").update(rawBody).digest("hex");
}
