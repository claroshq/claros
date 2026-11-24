/**
 * Symmetric encryption for credentials at rest (LLM configs, transport configs).
 *
 * Algorithm: AES-256-GCM (authenticated encryption with associated data).
 * Master key: 32-byte key provided by the caller (sourced from ENCRYPTION_KEY env var).
 *
 * Stored format: a versioned JSON envelope so key rotation and algorithm changes
 * can be handled without guessing which scheme wrote a given row:
 *
 *   { "v": 1, "alg": "aes-256-gcm", "iv": "<hex>", "tag": "<hex>", "data": "<hex>" }
 *
 * The caller stores this envelope as a TEXT column value. On read, parse the JSON,
 * check `v` and `alg`, then decrypt with the current key.
 *
 * Key rotation: decrypt with old key, re-encrypt with new key, update the row.
 * A rotation script (future) iterates all rows. No in-band rotation logic here.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The versioned envelope stored in the database. */
export interface EncryptedEnvelope {
  v: 1;
  alg: "aes-256-gcm";
  iv: string;   // hex, 12 bytes = 24 hex chars
  tag: string;  // hex, 16 bytes = 32 hex chars
  data: string; // hex, variable length
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALGORITHM = "aes-256-gcm" as const;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Encrypt a plaintext string with AES-256-GCM.
 *
 * @param plaintext - The string to encrypt (typically JSON-serialized credentials).
 * @param key - 32-byte Buffer (the master encryption key).
 * @returns The envelope as a JSON string, ready for database storage.
 * @throws If the key is not exactly 32 bytes.
 */
export function encrypt(plaintext: string, key: Buffer): string {
  validateKey(key);

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  const tag = cipher.getAuthTag();

  const envelope: EncryptedEnvelope = {
    v: 1,
    alg: ALGORITHM,
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    data: encrypted.toString("hex"),
  };

  return JSON.stringify(envelope);
}

/**
 * Decrypt an encrypted envelope string back to plaintext.
 *
 * @param envelopeJson - The JSON string stored in the database.
 * @param key - 32-byte Buffer (the master encryption key).
 * @returns The decrypted plaintext string.
 * @throws If the envelope is malformed, the version/algorithm is unsupported,
 *         the key is wrong (auth tag verification fails), or the key is invalid.
 */
export function decrypt(envelopeJson: string, key: Buffer): string {
  validateKey(key);

  let envelope: unknown;
  try {
    envelope = JSON.parse(envelopeJson);
  } catch {
    throw new Error("crypto.decrypt: envelope is not valid JSON");
  }

  if (!isEnvelope(envelope)) {
    throw new Error("crypto.decrypt: envelope shape is invalid or unsupported version/algorithm");
  }

  const iv = Buffer.from(envelope.iv, "hex");
  const tag = Buffer.from(envelope.tag, "hex");
  const data = Buffer.from(envelope.data, "hex");

  if (iv.length !== IV_BYTES) {
    throw new Error(`crypto.decrypt: IV must be ${IV_BYTES} bytes, got ${iv.length}`);
  }
  if (tag.length !== TAG_BYTES) {
    throw new Error(`crypto.decrypt: auth tag must be ${TAG_BYTES} bytes, got ${tag.length}`);
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(data),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

/**
 * Parse an ENCRYPTION_KEY environment variable value (base64-encoded, 32 bytes)
 * into a Buffer suitable for encrypt/decrypt.
 *
 * @param envValue - The base64-encoded key string (44 chars for 32 bytes).
 * @returns The decoded 32-byte Buffer.
 * @throws If the value is not valid base64 or does not decode to exactly 32 bytes.
 */
export function parseEncryptionKey(envValue: string): Buffer {
  const buf = Buffer.from(envValue, "base64");
  if (buf.length !== KEY_BYTES) {
    throw new Error(
      `ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes, got ${buf.length}. ` +
      `Provide a 32-byte key encoded as base64 (44 characters).`,
    );
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function validateKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new Error(`Encryption key must be a ${KEY_BYTES}-byte Buffer`);
  }
}

function isEnvelope(val: unknown): val is EncryptedEnvelope {
  if (typeof val !== "object" || val === null) return false;
  const obj = val as Record<string, unknown>;
  return (
    obj.v === 1 &&
    obj.alg === ALGORITHM &&
    typeof obj.iv === "string" &&
    typeof obj.tag === "string" &&
    typeof obj.data === "string"
  );
}
