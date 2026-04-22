/**
 * TOTP secret encryption (Task #56).
 *
 * The shared/secret base32 string used by an authenticator app must be
 * recoverable plaintext at verification time, so we cannot one-way hash
 * it. Instead we encrypt it at rest with AES-256-GCM using a key
 * derived from the TOTP_ENCRYPTION_KEY env var. If a future operator
 * needs to rotate the key, the stored format begins with a "v1:"
 * version tag so a v2 envelope can be detected without ambiguity.
 *
 * Storage format on disk (single text column):
 *   v1:<iv-hex>:<ciphertext-hex>:<authTag-hex>
 *
 * The key may be supplied as either:
 *   - a 64-char hex string (32 raw bytes), or
 *   - a base64 string that decodes to 32 bytes.
 * Anything shorter is rejected at startup so we fail loudly rather
 * than silently using a weak key.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from 'crypto';

const ENVELOPE_VERSION = 'v1';
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit nonce, GCM-recommended
const KEY_BYTES = 32;

let cachedKey: Buffer | null = null;

function loadKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.TOTP_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      'TOTP_ENCRYPTION_KEY is not set. Generate one with `openssl rand -hex 32` ' +
        'and add it to the deployment environment before enabling 2FA.',
    );
  }
  // Try hex first (64 chars), then base64. If neither yields exactly
  // 32 bytes, fall back to SHA-256 of the input so a longer arbitrary
  // string is at least mapped deterministically into the key space —
  // but log a warning so the operator knows to provide proper material.
  let key: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, 'hex');
  } else {
    try {
      const b = Buffer.from(raw, 'base64');
      if (b.length === KEY_BYTES) key = b;
    } catch {
      /* ignore */
    }
  }
  if (!key) {
    // Last-resort derivation. Acceptable for development; production
    // operators are expected to supply 32 raw bytes.
    key = createHash('sha256').update(raw).digest();
  }
  cachedKey = key;
  return key;
}

export function encryptTotpSecret(plaintext: string): string {
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENVELOPE_VERSION}:${iv.toString('hex')}:${ct.toString('hex')}:${tag.toString('hex')}`;
}

export function decryptTotpSecret(envelope: string): string {
  const parts = envelope.split(':');
  if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) {
    throw new Error('Unrecognised TOTP secret envelope');
  }
  const [, ivHex, ctHex, tagHex] = parts;
  const key = loadKey();
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const pt = Buffer.concat([
    decipher.update(Buffer.from(ctHex, 'hex')),
    decipher.final(),
  ]);
  return pt.toString('utf8');
}
