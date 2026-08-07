import { Inject, Injectable } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
  createHmac,
} from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../config';

/**
 * Envelope encryption for integration credentials.
 *
 * FORMAT — a single self-describing bytea blob:
 *
 *   [ version (1 byte) | iv (12 bytes) | authTag (16 bytes) | ciphertext (n) ]
 *
 * Why this shape:
 *
 * - **AES-256-GCM** is authenticated encryption. Tampering with any byte of the
 *   ciphertext, IV, or tag makes `decipher.final()` throw rather than silently
 *   returning garbage. For OAuth tokens, silent corruption would mean sending a
 *   malformed token to a partner API and getting an opaque failure.
 *
 * - **The key version is embedded in the payload**, not stored beside it. That
 *   makes each blob self-describing: during a key rotation, old rows decrypt
 *   with the retired key and new writes use the current key, with no migration
 *   and no ambiguity about which key a given row needs.
 *
 * - **A fresh random 96-bit IV per encryption.** GCM's security collapses if an
 *   IV is ever reused under the same key, so it is never derived or reused.
 *
 * - **AAD binds the ciphertext to its context.** Callers pass an `aad` (e.g.
 *   `integration:<id>`), so a blob copied from one integration row to another
 *   fails to decrypt. Without this, an attacker with write access could move a
 *   credential blob between tenants and the crypto would happily accept it.
 */

const VERSION_BYTES = 1;
const IV_BYTES = 12; // 96-bit, the GCM-recommended size
const AUTH_TAG_BYTES = 16;
const ALGORITHM = 'aes-256-gcm';

export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecryptionError';
  }
}

@Injectable()
export class CryptoService {
  private readonly currentKey: Buffer;
  private readonly currentVersion: number;
  private readonly previousKeys: ReadonlyMap<number, Buffer>;
  private readonly hashingSalt: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.currentKey = config.encryption.key;
    this.currentVersion = config.encryption.keyVersion;
    this.previousKeys = config.encryption.previousKeys;
    this.hashingSalt = config.auth.apiKeyHashingSalt;

    if (this.currentVersion > 255) {
      // The version occupies a single byte in the envelope header.
      throw new Error('ENCRYPTION_KEY_VERSION must be <= 255');
    }
  }

  /**
   * Encrypts plaintext with the current key.
   *
   * @param plaintext  The secret (e.g. a JSON credential bundle).
   * @param aad        Additional authenticated data binding this ciphertext to
   *                   its context. Pass the same value to `decrypt`.
   */
  encrypt(plaintext: string, aad?: string): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.currentKey, iv);

    if (aad) {
      cipher.setAAD(Buffer.from(aad, 'utf8'));
    }

    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const header = Buffer.alloc(VERSION_BYTES);
    header.writeUInt8(this.currentVersion, 0);

    return Buffer.concat([header, iv, authTag, ciphertext]);
  }

  /**
   * Decrypts an envelope, selecting the key by the version byte in its header.
   *
   * Throws `DecryptionError` if the blob is malformed, its key version is
   * unknown, or its authentication tag does not verify (i.e. it was tampered
   * with, or the AAD does not match).
   */
  decrypt(envelope: Buffer, aad?: string): string {
    const minimumLength = VERSION_BYTES + IV_BYTES + AUTH_TAG_BYTES;
    if (envelope.length < minimumLength) {
      throw new DecryptionError(
        `Malformed envelope: ${envelope.length} bytes, expected at least ${minimumLength}`,
      );
    }

    const version = envelope.readUInt8(0);
    const key = this.keyForVersion(version);

    const iv = envelope.subarray(VERSION_BYTES, VERSION_BYTES + IV_BYTES);
    const authTag = envelope.subarray(
      VERSION_BYTES + IV_BYTES,
      VERSION_BYTES + IV_BYTES + AUTH_TAG_BYTES,
    );
    const ciphertext = envelope.subarray(VERSION_BYTES + IV_BYTES + AUTH_TAG_BYTES);

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    if (aad) {
      decipher.setAAD(Buffer.from(aad, 'utf8'));
    }

    try {
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      // Deliberately opaque: never leak whether the tag, key, or AAD was wrong.
      throw new DecryptionError(
        'Decryption failed: the payload was tampered with, or the key/context does not match',
      );
    }
  }

  /** Convenience wrapper for structured credential bundles. */
  encryptJson(value: unknown, aad?: string): Buffer {
    return this.encrypt(JSON.stringify(value), aad);
  }

  decryptJson<T>(envelope: Buffer, aad?: string): T {
    return JSON.parse(this.decrypt(envelope, aad)) as T;
  }

  /** The key version new writes will use — persisted alongside each row. */
  get keyVersion(): number {
    return this.currentVersion;
  }

  private keyForVersion(version: number): Buffer {
    if (version === this.currentVersion) return this.currentKey;

    const previous = this.previousKeys.get(version);
    if (previous) return previous;

    throw new DecryptionError(
      `Unknown encryption key version ${version}. ` +
        'Add it to KEY_ENCRYPTION_KEYS_PREVIOUS to decrypt data written before the last rotation.',
    );
  }

  // --- API key hashing -----------------------------------------------------

  /**
   * HMAC-SHA256 of an API key. Used instead of bcrypt deliberately: API keys are
   * high-entropy random values, not user-chosen passwords, so slow hashing buys
   * nothing against brute force but would add latency to every request.
   */
  hashApiKey(rawKey: string): string {
    return createHmac('sha256', this.hashingSalt).update(rawKey).digest('hex');
  }

  /** Constant-time comparison — avoids leaking match position via timing. */
  verifyApiKey(rawKey: string, storedHash: string): boolean {
    const computed = Buffer.from(this.hashApiKey(rawKey), 'hex');
    let stored: Buffer;
    try {
      stored = Buffer.from(storedHash, 'hex');
    } catch {
      return false;
    }
    if (computed.length !== stored.length) return false;
    return timingSafeEqual(computed, stored);
  }

  /** Generates a new API key: `cap_<40 hex chars>`. Shown to the user once. */
  generateApiKey(): { raw: string; prefix: string; hash: string } {
    const raw = `cap_${randomBytes(20).toString('hex')}`;
    return {
      raw,
      prefix: raw.slice(0, 12),
      hash: this.hashApiKey(raw),
    };
  }
}
