import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { Role } from '@prisma/client';

export const IS_PUBLIC_KEY = 'isPublic';
/** Route does not require a JWT (a token is still parsed if present). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const ROLES_KEY = 'roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

export const ADMIN_ROLES: Role[] = [Role.ADMIN, Role.SUPER_ADMIN];
export const STAFF_ROLES: Role[] = [Role.ADMIN, Role.SUPER_ADMIN, Role.CALL_AGENT];

export interface AuthUser {
  sub: string;
  role: Role;
}

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user;
});

export const ClientIp = createParamDecorator((_: unknown, ctx: ExecutionContext): string | undefined => {
  return ctx.switchToHttp().getRequest().ip;
});
