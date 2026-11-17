import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { paginate } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditEntry {
  actorId?: string;
  action: string;
  entity: string;
  entityId?: string | number;
  before?: unknown;
  after?: unknown;
  ip?: string;
}

/** Records who changed what (doctor, fee, booking, payment…). A failed write never breaks the request. */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async log(e: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          actorId: e.actorId,
          action: e.action,
          entity: e.entity,
          entityId: e.entityId !== undefined ? String(e.entityId) : undefined,
          before: (e.before ?? undefined) as Prisma.InputJsonValue | undefined,
          after: (e.after ?? undefined) as Prisma.InputJsonValue | undefined,
          ip: e.ip,
        },
      });
    } catch (err) {
      this.logger.error(`audit write failed: ${(err as Error).message}`);
    }
  }

  async list(page: number, limit: number, entity?: string) {
    const where: Prisma.AuditLogWhereInput = entity ? { entity } : {};
    const [items, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: { actor: { select: { id: true, name: true, email: true, role: true } } },
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return paginate(items, total, page, limit);
  }
}

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
