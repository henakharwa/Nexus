import { randomBytes, createCipheriv, createDecipheriv, createHash } from "node:crypto";

// AES-256-GCM at-rest encryption for integration tokens (GitHub PATs, Slack
// bot tokens). Real encryption, not obfuscation: a random 12-byte IV per
// call, the GCM auth tag stored alongside the ciphertext so tampering is
// detectable, both fed from a 32-byte key the deployer controls via
// INTEGRATION_ENCRYPTION_KEY -- never hardcoded here.

type KeyRing = { activeId: string; keys: Map<string, Buffer> };

function decodeKey(label: string, b64: string): Buffer {
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) {
    throw new Error(`${label} must decode to 32 bytes, got ${key.length}`);
  }
  return key;
}

/** INTEGRATION_ENCRYPTION_KEYS accepts `key-id=base64-key,...`; its first
 * key encrypts new records while every listed key can decrypt existing ones. */
function getKeyRing(): KeyRing {
  const configured = process.env.INTEGRATION_ENCRYPTION_KEYS?.trim();
  if (configured) {
    const keys = new Map<string, Buffer>();
    for (const entry of configured.split(",")) {
      const [id, b64] = entry.split("=", 2).map((part) => part.trim());
      if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || !b64) throw new Error("INTEGRATION_ENCRYPTION_KEYS entries must be key-id=base64-32-byte-key");
      keys.set(id, decodeKey(`INTEGRATION_ENCRYPTION_KEYS (${id})`, b64));
    }
    const activeId = keys.keys().next().value as string | undefined;
    if (!activeId) throw new Error("INTEGRATION_ENCRYPTION_KEYS must contain at least one key");
    return { activeId, keys };
  }
  const b64 = process.env.INTEGRATION_ENCRYPTION_KEY;
  if (!b64) throw new Error("INTEGRATION_ENCRYPTION_KEY or INTEGRATION_ENCRYPTION_KEYS is not set");
  return { activeId: "legacy", keys: new Map([["legacy", decodeKey("INTEGRATION_ENCRYPTION_KEY", b64)]]) };
}

export function encryptToken(plaintext: string): string {
  const { activeId, keys } = getKeyRing();
  const key = keys.get(activeId)!;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return ["v2", activeId, iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(":");
}

export function decryptToken(encrypted: string): string {
  const ring = getKeyRing();
  const parts = encrypted.split(":");
  const versioned = parts[0] === "v2";
  if ((versioned && parts.length !== 5) || (!versioned && parts.length !== 3)) {
    throw new Error("malformed encrypted token");
  }
  const [keyId, ivB64, authTagB64, ciphertextB64] = versioned
    ? [parts[1], parts[2], parts[3], parts[4]]
    : ["legacy", parts[0], parts[1], parts[2]];
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");
  const ciphertext = Buffer.from(ciphertextB64, "base64");
  const candidates = versioned
    ? (() => { const key = ring.keys.get(keyId); if (!key) throw new Error(`encrypted token uses unavailable key '${keyId}'`); return [key]; })()
    // Legacy records had no key id. Try each configured key so an operator
    // can introduce a named key ring before running the migration command.
    : [...ring.keys.values()];
  let lastError: unknown;
  for (const key of candidates) {
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch (error) { lastError = error; }
  }
  throw lastError instanceof Error ? lastError : new Error("could not decrypt token");
}

export function needsTokenReencryption(encrypted: string): boolean {
  const ring = getKeyRing();
  const parts = encrypted.split(":");
  return parts[0] !== "v2" || parts[1] !== ring.activeId;
}

// Session tokens (services/chat-server/src/auth.ts) are handled
// differently from the integration tokens above: there's nothing to
// decrypt back -- the raw token only ever needs to be *recognized* again
// (does this cookie match a live session?), never read back out. A
// one-way SHA-256 hash is the standard shape for that (same reason a
// password or API key gets hashed, not encrypted): even a full read of
// the `sessions` table's `token_hash` column can't be turned back into a
// working session cookie. No secret key involved -- the token itself
// (32 random bytes, generated in auth.ts) is already the only thing that
// needs to stay secret, and it never touches disk in this form.
export function hashSessionToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}
