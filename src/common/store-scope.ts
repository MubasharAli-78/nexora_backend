import { RequestContext } from './context/request-context';

/**
 * Returns a Prisma `storeId` filter fragment honoring the user's store scope.
 * Empty storeScope = access to all stores in the tenant (returns {}).
 * If a specific storeId is requested it must be within scope.
 */
export function storeScopeFilter(ctx: RequestContext, requestedStoreId?: string): Record<string, unknown> {
  if (requestedStoreId) {
    if (ctx.storeScope.length > 0 && !ctx.storeScope.includes(requestedStoreId)) {
      return { storeId: '__forbidden__' }; // yields no rows
    }
    return { storeId: requestedStoreId };
  }
  if (ctx.storeScope.length > 0) {
    return { storeId: { in: ctx.storeScope } };
  }
  return {};
}
