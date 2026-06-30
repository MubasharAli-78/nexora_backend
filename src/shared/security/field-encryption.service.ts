import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import type { AppEnv } from '../config/env.schema';

/**
 * AES-256-GCM field-level encryption for PII (customer email/phone/address) and
 * integration secrets. Output format: base64(iv).base64(tag).base64(ciphertext).
 */
@Injectable()
export class FieldEncryptionService {
  private readonly key: Buffer;

  constructor(config: ConfigService<AppEnv, true>) {
    const raw = config.get('FIELD_ENCRYPTION_KEY', { infer: true });
    // Derive a stable 32-byte key from whatever the operator provided.
    this.key = createHash('sha256').update(raw).digest();
  }

  encrypt(plain: string | null | undefined): string | null {
    if (plain === null || plain === undefined || plain === '') return null;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('base64')}.${tag.toString('base64')}.${ciphertext.toString('base64')}`;
  }

  decrypt(payload: string | null | undefined): string | null {
    if (!payload) return null;
    const [ivB64, tagB64, dataB64] = payload.split('.');
    if (!ivB64 || !tagB64 || !dataB64) return null;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivB64, 'base64'));
      decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
      const plain = Buffer.concat([
        decipher.update(Buffer.from(dataB64, 'base64')),
        decipher.final(),
      ]);
      return plain.toString('utf8');
    } catch {
      return null;
    }
  }

  /** Deterministic hash for blind-equality search (e.g. email lookup) without decryption. */
  blindHash(value: string | null | undefined): string | null {
    if (!value) return null;
    return createHash('sha256')
      .update(`${this.key.toString('hex')}:${value.toLowerCase()}`)
      .digest('hex');
  }
}
