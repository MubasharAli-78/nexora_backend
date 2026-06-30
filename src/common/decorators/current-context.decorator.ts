import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { RequestContext } from '../context/request-context';

/** Injects the resolved, tenant-scoped RequestContext into a controller handler. */
export const CurrentContext = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestContext => {
    const req = ctx.switchToHttp().getRequest();
    return req.context as RequestContext;
  },
);

/** Convenience: injects just the authenticated user id. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const req = ctx.switchToHttp().getRequest();
    return (req.context as RequestContext)?.userId;
  },
);
