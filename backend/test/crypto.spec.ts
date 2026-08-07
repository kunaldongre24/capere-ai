import { describe, expect, it } from 'vitest';
import { CryptoService, DecryptionError } from '../src/shared/crypto/crypto.service';
import type { AppConfig } from '../src/shared/config';

const KEY_V1 = Buffer.alloc(32, 1);
const KEY_V2 = Buffer.alloc(32, 2);

function makeService(
  options: {
    version?: number;
    key?: Buffer;
    previous?: Map<number, Buffer>;
  } = {},
): CryptoService {
  const config = {
    auth: { apiKeyHashingSalt: 'test-salt-0123456789abcdef', openWebUiApiKey: 'x' },
    encryption: {
      key: options.key ?? KEY_V1,
      keyVersion: options.version ?? 1,
      previousKeys: options.previous ?? new Map<number, Buffer>(),
    },
  } as unknown as AppConfig;

  return new CryptoService(config);
}

describe('CryptoService', () => {
  describe('encryption round-trip', () => {
    it('decrypts what it encrypts', () => {
      const crypto = makeService();
      const secret = 'ghl_access_token_abc123';
      expect(crypto.decrypt(crypto.encrypt(secret))).toBe(secret);
    });

    it('round-trips structured credential bundles', () => {
      const crypto = makeService();
      const credentials = {
        accessToken: 'at_123',
        refreshToken: 'rt_456',
        expiresAt: '2026-08-04T00:00:00.000Z',
      };
      const envelope = crypto.encryptJson(credentials);
      expect(crypto.decryptJson<typeof credentials>(envelope)).toEqual(credentials);
    });

    it('produces a different ciphertext each time (fresh IV)', () => {
      const crypto = makeService();
      const a = crypto.encrypt('same-plaintext');
      const b = crypto.encrypt('same-plaintext');

      // Identical input must not yield identical output — otherwise an observer
      // could tell that two integrations share a credential.
      expect(a.equals(b)).toBe(false);
      expect(crypto.decrypt(a)).toBe(crypto.decrypt(b));
    });

    it('handles empty strings and unicode', () => {
      const crypto = makeService();
      expect(crypto.decrypt(crypto.encrypt(''))).toBe('');
      expect(crypto.decrypt(crypto.encrypt('café ☕ 日本語'))).toBe('café ☕ 日本語');
    });
  });

  describe('tamper detection', () => {
    it('rejects a modified ciphertext', () => {
      const crypto = makeService();
      const envelope = crypto.encrypt('sensitive-token');

      // Flip one bit in the ciphertext body.
      const tampered = Buffer.from(envelope);
      tampered[tampered.length - 1] ^= 0x01;

      expect(() => crypto.decrypt(tampered)).toThrow(DecryptionError);
    });

    it('rejects a modified auth tag', () => {
      const crypto = makeService();
      const envelope = crypto.encrypt('sensitive-token');
      const tampered = Buffer.from(envelope);
      tampered[13] ^= 0x01; // within the auth tag region

      expect(() => crypto.decrypt(tampered)).toThrow(DecryptionError);
    });

    it('rejects a modified IV', () => {
      const crypto = makeService();
      const envelope = crypto.encrypt('sensitive-token');
      const tampered = Buffer.from(envelope);
      tampered[1] ^= 0x01; // within the IV region

      expect(() => crypto.decrypt(tampered)).toThrow(DecryptionError);
    });

    it('rejects a truncated envelope', () => {
      const crypto = makeService();
      expect(() => crypto.decrypt(Buffer.alloc(4))).toThrow(/Malformed envelope/);
    });

    it('does not leak why decryption failed', () => {
      const crypto = makeService();
      const tampered = Buffer.from(crypto.encrypt('x'));
      tampered[tampered.length - 1] ^= 0xff;

      // The message must not distinguish "wrong key" from "bad tag" from
      // "wrong AAD" — that distinction is an oracle.
      expect(() => crypto.decrypt(tampered)).toThrow(
        /tampered with, or the key\/context does not match/,
      );
    });
  });

  describe('AAD context binding', () => {
    it('decrypts when the AAD matches', () => {
      const crypto = makeService();
      const envelope = crypto.encrypt('token', 'integration:abc');
      expect(crypto.decrypt(envelope, 'integration:abc')).toBe('token');
    });

    it('refuses a blob moved to a different context', () => {
      const crypto = makeService();
      const envelope = crypto.encrypt('token', 'integration:abc');

      // This is the attack AAD defends against: copying a credential blob from
      // one integration row (or tenant) into another.
      expect(() => crypto.decrypt(envelope, 'integration:xyz')).toThrow(DecryptionError);
    });

    it('refuses when AAD is omitted at decryption', () => {
      const crypto = makeService();
      const envelope = crypto.encrypt('token', 'integration:abc');
      expect(() => crypto.decrypt(envelope)).toThrow(DecryptionError);
    });
  });

  describe('key rotation', () => {
    it('embeds the key version in the envelope', () => {
      const crypto = makeService({ version: 7 });
      expect(crypto.encrypt('x').readUInt8(0)).toBe(7);
      expect(crypto.keyVersion).toBe(7);
    });

    it('decrypts data written before a rotation', () => {
      // Write under v1...
      const before = makeService({ version: 1, key: KEY_V1 });
      const envelope = before.encrypt('long-lived-refresh-token');

      // ...then rotate to v2, retaining v1 for reads.
      const after = makeService({
        version: 2,
        key: KEY_V2,
        previous: new Map([[1, KEY_V1]]),
      });

      expect(after.decrypt(envelope)).toBe('long-lived-refresh-token');
      // New writes use the new version.
      expect(after.encrypt('new-token').readUInt8(0)).toBe(2);
    });

    it('fails with an actionable message when a key version is missing', () => {
      const before = makeService({ version: 1, key: KEY_V1 });
      const envelope = before.encrypt('orphaned');

      const after = makeService({ version: 2, key: KEY_V2 }); // v1 not retained

      expect(() => after.decrypt(envelope)).toThrow(/Unknown encryption key version 1/);
      expect(() => after.decrypt(envelope)).toThrow(/KEY_ENCRYPTION_KEYS_PREVIOUS/);
    });

    it('refuses a key version that cannot fit the header byte', () => {
      expect(() => makeService({ version: 256 })).toThrow(/<= 255/);
    });
  });

  describe('API keys', () => {
    it('generates a prefixed key with a matching hash', () => {
      const crypto = makeService();
      const { raw, prefix, hash } = crypto.generateApiKey();

      expect(raw).toMatch(/^cap_[0-9a-f]{40}$/);
      expect(raw.startsWith(prefix)).toBe(true);
      expect(crypto.verifyApiKey(raw, hash)).toBe(true);
    });

    it('rejects an incorrect key', () => {
      const crypto = makeService();
      const { hash } = crypto.generateApiKey();
      expect(crypto.verifyApiKey('cap_wrong', hash)).toBe(false);
    });

    it('rejects a malformed stored hash without throwing', () => {
      const crypto = makeService();
      const { raw } = crypto.generateApiKey();
      expect(crypto.verifyApiKey(raw, 'not-hex')).toBe(false);
    });

    it('is deterministic for the same key and salt', () => {
      const crypto = makeService();
      const { raw } = crypto.generateApiKey();
      expect(crypto.hashApiKey(raw)).toBe(crypto.hashApiKey(raw));
    });

    it('never stores the raw key in the hash', () => {
      const crypto = makeService();
      const { raw, hash } = crypto.generateApiKey();
      expect(hash).not.toContain(raw);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});
