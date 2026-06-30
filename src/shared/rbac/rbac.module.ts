import { Global, Module } from '@nestjs/common';
import { MembershipContextService } from './membership-context.service';

@Global()
@Module({
  providers: [MembershipContextService],
  exports: [MembershipContextService],
})
export class RbacModule {}
