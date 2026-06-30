import { Body, Controller, Delete, Get, Param, Patch } from '@nestjs/common';
import { TeamService } from './team.service';
import {
  updateStatusSchema,
  updateRolesSchema,
  type UpdateStatusDto,
  type UpdateRolesDto,
} from './team.schemas';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { CurrentContext } from '../../common/decorators/current-context.decorator';
import { RequestContext } from '../../common/context/request-context';

@Controller('team')
export class TeamController {
  constructor(private readonly team: TeamService) {}

  @Get('members')
  @RequirePermissions('users.read')
  list(@CurrentContext() ctx: RequestContext) {
    return this.team.listMembers(ctx);
  }

  @Get('members/:memberId')
  @RequirePermissions('users.read')
  get(@CurrentContext() ctx: RequestContext, @Param('memberId') memberId: string) {
    return this.team.getMember(ctx, memberId);
  }

  @Patch('members/:memberId/status')
  @RequirePermissions('users.manage')
  status(@CurrentContext() ctx: RequestContext, @Param('memberId') memberId: string, @Body(new ZodValidationPipe(updateStatusSchema)) body: UpdateStatusDto) {
    return this.team.updateStatus(ctx, memberId, body);
  }

  @Patch('members/:memberId/roles')
  @RequirePermissions('users.manage')
  roles(@CurrentContext() ctx: RequestContext, @Param('memberId') memberId: string, @Body(new ZodValidationPipe(updateRolesSchema)) body: UpdateRolesDto) {
    return this.team.updateRoles(ctx, memberId, body);
  }

  @Delete('members/:memberId')
  @RequirePermissions('users.manage')
  remove(@CurrentContext() ctx: RequestContext, @Param('memberId') memberId: string) {
    return this.team.removeMember(ctx, memberId);
  }
}
