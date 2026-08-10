import { createCipheriv, createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptGhlSsoData } from '../src/integrations/ghl/ghl-sso.service';

function encryptLikeHighLevel(value: unknown, secret: string) {
  const salt = Buffer.from('12345678');
  const secretBuffer = Buffer.from(secret, 'utf8');
  let material = Buffer.alloc(0);
  let previous = Buffer.alloc(0);
  while (material.length < 48) {
    previous = createHash('md5')
      .update(Buffer.concat([previous, secretBuffer, salt]))
      .digest();
    material = Buffer.concat([material, previous]);
  }
  const cipher = createCipheriv('aes-256-cbc', material.subarray(0, 32), material.subarray(32, 48));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([Buffer.from('Salted__'), salt, encrypted]).toString('base64');
}

describe('GoHighLevel embedded SSO', () => {
  it('decrypts the official CryptoJS/OpenSSL custom-page payload format', () => {
    const secret = 'shared-secret-for-test';
    const encrypted = encryptLikeHighLevel(
      {
        userId: 'ghl-user',
        companyId: 'ghl-company',
        role: 'admin',
        type: 'location',
        activeLocation: 'ghl-location',
        userName: 'Test User',
        email: 'test@example.com',
      },
      secret,
    );

    expect(decryptGhlSsoData(encrypted, secret)).toMatchObject({
      userId: 'ghl-user',
      activeLocation: 'ghl-location',
      email: 'test@example.com',
    });
  });

  it('rejects data that was not encrypted with the app shared secret', () => {
    const encrypted = encryptLikeHighLevel(
      { userId: 'attacker', activeLocation: 'other-location', email: 'x@example.com' },
      'wrong-secret',
    );

    expect(() => decryptGhlSsoData(encrypted, 'real-secret')).toThrow(
      'GoHighLevel session context could not be verified',
    );
  });
});
