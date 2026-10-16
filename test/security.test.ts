import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  decryptSecret,
  encryptSecret,
  isBlockedAddress,
  validateDestinationUrl,
  verifyErlcSignature
} from "../src/security.js";

test("encrypts secrets with authenticated encryption", () => {
  const key = crypto.randomBytes(32);
  const encrypted = encryptSecret("server-key-value", key);
  assert.notEqual(encrypted, "server-key-value");
  assert.equal(decryptSecret(encrypted, key), "server-key-value");
  assert.throws(() => decryptSecret(`${encrypted}broken`, key));
});

test("verifies timestamp plus exact raw webhook bytes", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicDer = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const rawBody = Buffer.from('{"event":"CustomCommand"}');
  const now = Date.now();
  const timestamp = String(Math.floor(now / 1000));
  const signature = crypto.sign(null, Buffer.concat([Buffer.from(timestamp), rawBody]), privateKey).toString("hex");
  assert.equal(verifyErlcSignature({ rawBody, timestamp, signature, publicKeySpkiBase64: publicDer, maxClockSkewSeconds: 300, now }), true);
  assert.equal(verifyErlcSignature({ rawBody: Buffer.from(`${rawBody.toString()} `), timestamp, signature, publicKeySpkiBase64: publicDer, maxClockSkewSeconds: 300, now }), false);
  assert.equal(verifyErlcSignature({ rawBody, timestamp: "1", signature, publicKeySpkiBase64: publicDer, maxClockSkewSeconds: 300, now }), false);
});

test("allows public HTTP self-hosting while blocking internal networks", async () => {
  const direct = await validateDestinationUrl("http://8.8.8.8:3000/events");
  assert.equal(direct.transportSecurity, "unencrypted");
  assert.equal(direct.addresses[0], "8.8.8.8");

  const named = await validateDestinationUrl("https://events.example.com/events", async () => [
    { address: "8.8.4.4", family: 4 }
  ] as never);
  assert.equal(named.transportSecurity, "encrypted");

  await assert.rejects(() => validateDestinationUrl("http://127.0.0.1:3000/events"), /blocked network/);
  await assert.rejects(() => validateDestinationUrl("http://10.0.0.1:8080/events"), /blocked network/);
  await assert.rejects(() => validateDestinationUrl("ftp://8.8.8.8/events"), /HTTP or HTTPS/);
  await assert.rejects(() => validateDestinationUrl("http://8.8.8.8:22/events"), /port is not allowed/);
  assert.equal(isBlockedAddress("169.254.169.254"), true);
});
