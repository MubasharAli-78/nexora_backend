import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from './permissions.guard';
import { PERMISSIONS_KEY } from '../decorators/require-permissions.decorator';

function execCtx(permissions: string[] | undefined, ctxPermissions: string[]) {
  const reflector = new Reflector();
  jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key: string) => {
    if (key === PERMISSIONS_KEY) return permissions as never;
    return false as never; // IS_PUBLIC_KEY
  });
  const guard = new PermissionsGuard(reflector);
  const ctx = {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => ({ context: { permissions: ctxPermissions } }) }),
  } as never;
  return { guard, ctx };
}

describe('PermissionsGuard', () => {
  it('allows when no permissions are required', () => {
    const { guard, ctx } = execCtx(undefined, []);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('allows when the context has all required permissions', () => {
    const { guard, ctx } = execCtx(['products.read'], ['dashboard.read', 'products.read']);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('denies when a required permission is missing', () => {
    const { guard, ctx } = execCtx(['roles.manage'], ['dashboard.read']);
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });
});
