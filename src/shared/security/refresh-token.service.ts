import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';

@Injectable()
export class RefreshTokenService {
  /** Generates an opaque, high-entropy refresh token (returned to the client raw). */
  generate(): string {
    return randomBytes(48).toString('base64url');
  }

  /** Tokens are stored only as a SHA-256 hash, never in plaintext. */
  hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
