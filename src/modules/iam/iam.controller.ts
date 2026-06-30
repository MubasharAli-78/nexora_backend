import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { IamService } from './iam.service';
import {
  createRoleSchema,
  updateRoleSchema,
  setRolePermissionsSchema,
  createAssignmentSchema,
  type CreateRoleDto,
  type UpdateRoleDto,
  type SetRolePermissionsDto,
  type CreateAssignmentDto,
} from './iam.schemas';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { CurrentContext } from '../../common/decorators/current-context.decorator';
import { RequestContext } from '../../common/context/request-context';

@Controller('iam')
export class IamController {
  constructor(private readonly iam: IamService) {}

  @Get('permissions')
  @RequirePermissions('roles.read')
  permissions(@CurrentContext() ctx: RequestContext) {
    return this.iam.listPermissions(ctx);
  }

  @Get('roles')
  @RequirePermissions('roles.read')
  roles(@CurrentContext() ctx: RequestContext) {
    return this.iam.listRoles(ctx);
  }

  @Post('roles')
  @RequirePermissions('roles.manage')
  createRole(@CurrentContext() ctx: RequestContext, @Body(new ZodValidationPipe(createRoleSchema)) body: CreateRoleDto) {
    return this.iam.createRole(ctx, body);
  }

  @Patch('roles/:roleId')
  @RequirePermissions('roles.manage')
  updateRole(@CurrentContext() ctx: RequestContext, @Param('roleId') roleId: string, @Body(new ZodValidationPipe(updateRoleSchema)) body: UpdateRoleDto) {
    return this.iam.updateRole(ctx, roleId, body);
  }

  @Delete('roles/:roleId')
  @RequirePermissions('roles.manage')
  deleteRole(@CurrentContext() ctx: RequestContext, @Param('roleId') roleId: string) {
    return this.iam.deleteRole(ctx, roleId);
  }

  @Patch('roles/:roleId/permissions')
  @RequirePermissions('roles.manage')
  setPermissions(@CurrentContext() ctx: RequestContext, @Param('roleId') roleId: string, @Body(new ZodValidationPipe(setRolePermissionsSchema)) body: SetRolePermissionsDto) {
    return this.iam.setRolePermissions(ctx, roleId, body);
  }

  @Post('role-assignments')
  @RequirePermissions('roles.manage')
  assign(@CurrentContext() ctx: RequestContext, @Body(new ZodValidationPipe(createAssignmentSchema)) body: CreateAssignmentDto) {
    return this.iam.createAssignment(ctx, body);
  }

  @Delete('role-assignments/:assignmentId')
  @RequirePermissions('roles.manage')
  unassign(@CurrentContext() ctx: RequestContext, @Param('assignmentId') assignmentId: string) {
    return this.iam.deleteAssignment(ctx, assignmentId);
  }
}
