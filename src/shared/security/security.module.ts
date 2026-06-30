import { Global, Module } from '@nestjs/common';
import { JwtService } from './jwt.service';
import { PasswordService } from './password.service';
import { RefreshTokenService } from './refresh-token.service';
import { FieldEncryptionService } from './field-encryption.service';

@Global()
@Module({
  providers: [JwtService, PasswordService, RefreshTokenService, FieldEncryptionService],
  exports: [JwtService, PasswordService, RefreshTokenService, FieldEncryptionService],
})
export class SecurityModule {}
