import { ConfigService } from '@nestjs/config';
import { PasswordService } from './password.service';
import { RefreshTokenService } from './refresh-token.service';
import { FieldEncryptionService } from './field-encryption.service';
import { JwtService } from './jwt.service';

function fakeConfig(values: Record<string, unknown>): ConfigService<any, true> {
  return { get: (k: string) => values[k] } as unknown as ConfigService<any, true>;
}

describe('PasswordService', () => {
  const svc = new PasswordService();
  it('hashes and verifies correctly', async () => {
    const hash = await svc.hash('Sup3rSecret!');
    expect(hash).not.toContain('Sup3rSecret');
    expect(await svc.verify(hash, 'Sup3rSecret!')).toBe(true);
    expect(await svc.verify(hash, 'wrong')).toBe(false);
  });
});

describe('RefreshTokenService', () => {
  const svc = new RefreshTokenService();
  it('produces unique tokens with stable hashes', () => {
    const a = svc.generate();
    const b = svc.generate();
    expect(a).not.toEqual(b);
    expect(svc.hash(a)).toEqual(svc.hash(a));
    expect(svc.hash(a)).not.toEqual(svc.hash(b));
  });
});

describe('FieldEncryptionService', () => {
  const svc = new FieldEncryptionService(fakeConfig({ FIELD_ENCRYPTION_KEY: 'unit-test-key-please-change-0001' }));
  it('round-trips encryption and hides plaintext', () => {
    const enc = svc.encrypt('alex@example.com');
    expect(enc).not.toBeNull();
    expect(enc).not.toContain('alex@example.com');
    expect(svc.decrypt(enc)).toBe('alex@example.com');
  });
  it('blind hash is deterministic and case-insensitive', () => {
    expect(svc.blindHash('A@B.com')).toBe(svc.blindHash('a@b.com'));
  });
  it('handles null/empty', () => {
    expect(svc.encrypt(null)).toBeNull();
    expect(svc.decrypt(null)).toBeNull();
  });
});

describe('JwtService', () => {
  const svc = new JwtService(
    fakeConfig({ JWT_ACCESS_SECRET: 'unit-secret-unit-secret', JWT_ACCESS_TTL: 900, JWT_ISSUER: 'nexora', JWT_AUDIENCE: 'nexora-app' }),
  );
  const claims = {
    sub: 'u1', sid: 's1', tenant_id: 't1', tenant_slug: 'acme', membership_id: 'm1',
    roles: ['owner'], primary_role: 'owner', permissions: ['dashboard.read'], store_scope: [],
    rbac_version: 1, membership_permission_version: 1,
  };
  it('signs and verifies a token with claims intact', () => {
    const token = svc.signAccessToken(claims);
    const decoded = svc.verifyAccessToken(token);
    expect(decoded.sub).toBe('u1');
    expect(decoded.permissions).toContain('dashboard.read');
    expect(decoded.tenant_id).toBe('t1');
  });
  it('rejects a tampered/invalid token', () => {
    expect(() => svc.verifyAccessToken('not.a.jwt')).toThrow();
  });
});
