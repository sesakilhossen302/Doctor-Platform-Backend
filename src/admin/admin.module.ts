import { Body, Controller, ForbiddenException, Get, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { AppointmentStatus, DoctorStatus, Prisma, Role, UserStatus, VerificationStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { AuditService } from '../audit/audit.service';
import { CacheService } from '../cache/cache.service';
import { ADMIN_ROLES, AuthUser, ClientIp, CurrentUser, Roles } from '../common/decorators';
import { paginate, PaginationDto } from '../common/pagination';
import { addDays, dhakaDate, dhakaDateTime } from '../common/utils';
import { PrismaService } from '../prisma/prisma.service';

const PAID: AppointmentStatus[] = [AppointmentStatus.CONFIRMED, AppointmentStatus.COMPLETED, AppointmentStatus.NO_SHOW];
const STAFF_ASSIGNABLE: Role[] = [Role.ADMIN, Role.CALL_AGENT, Role.DOCTOR_ASSISTANT];

class StaffDto {
  @ApiProperty() @IsString() @MaxLength(80) name: string;
  @ApiProperty() @IsEmail() email: string;
  @ApiProperty() @IsString() @MinLength(8) @MaxLength(72) password: string;
  @ApiProperty({ enum: STAFF_ASSIGNABLE }) @IsIn(STAFF_ASSIGNABLE) role: Role;
}

class UserStatusDto {
  @ApiProperty({ enum: UserStatus }) @IsEnum(UserStatus) status: UserStatus;
}

class AuditQuery extends PaginationDto {
  @ApiPropertyOptional() @IsOptional() @IsString() entity?: string;
}

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
  ) {}

  /** Everything the overview page needs, in one cached call (30 s). */
  async dashboard() {
    return this.cache.wrap('admin:dashboard', 30, async () => {
      const today = dhakaDate();
      const todayStart = dhakaDateTime(today, '00:00');
      const todayEnd = new Date(todayStart.getTime() + 86_400_000);
      const seriesStart = dhakaDateTime(addDays(today, -13), '00:00');

      const [patients, doctors, pendingVerification, appointments, todayAppointments, pendingPayment, revenue, series, topSpecialties, recent] =
        await Promise.all([
          this.prisma.user.count({ where: { role: Role.PATIENT } }),
          this.prisma.doctor.count({ where: { status: DoctorStatus.ACTIVE, verificationStatus: VerificationStatus.VERIFIED } }),
          this.prisma.doctor.count({ where: { verificationStatus: VerificationStatus.PENDING, status: { not: DoctorStatus.ARCHIVED } } }),
          this.prisma.appointment.count({ where: { status: { in: PAID } } }),
          this.prisma.appointment.count({ where: { scheduledAt: { gte: todayStart, lt: todayEnd }, status: { in: PAID } } }),
          this.prisma.appointment.count({ where: { status: AppointmentStatus.PENDING_PAYMENT, holdExpiresAt: { gt: new Date() } } }),
          this.prisma.appointment.aggregate({ where: { status: { in: PAID } }, _sum: { totalAmount: true, platformFee: true } }),
          this.prisma.$queryRaw<{ day: string; bookings: bigint; revenue: bigint | null }[]>`
            SELECT to_char(("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Dhaka')::date, 'YYYY-MM-DD') AS day,
                   COUNT(*) AS bookings,
                   SUM("totalAmount") FILTER (WHERE status IN ('CONFIRMED','COMPLETED','NO_SHOW')) AS revenue
            FROM appointments
            WHERE "createdAt" >= ${seriesStart}
            GROUP BY 1 ORDER BY 1`,
          this.prisma.$queryRaw<{ id: number; nameEn: string; nameBn: string; bookings: bigint }[]>`
            SELECT s.id, s."nameEn", s."nameBn", COUNT(a.id) AS bookings
            FROM specialties s
            JOIN doctor_specialties ds ON ds."specialtyId" = s.id AND ds."isPrimary" = true
            LEFT JOIN appointments a ON a."doctorId" = ds."doctorId"
            GROUP BY s.id ORDER BY bookings DESC, s."nameEn" LIMIT 6`,
          this.prisma.appointment.findMany({
            orderBy: { createdAt: 'desc' },
            take: 8,
            select: {
              id: true, code: true, status: true, type: true, scheduledAt: true, totalAmount: true, patientName: true,
              doctor: { select: { nameEn: true, photoUrl: true } },
            },
          }),
        ]);

      const byDay = new Map(series.map((r) => [r.day, r]));
      const chart = Array.from({ length: 14 }, (_, i) => {
        const day = addDays(today, i - 13);
        const r = byDay.get(day);
        return { day, bookings: Number(r?.bookings ?? 0), revenue: Number(r?.revenue ?? 0) };
      });

      return {
        totals: {
          patients,
          doctors,
          pendingVerification,
          appointments,
          todayAppointments,
          pendingPayment,
          revenue: revenue._sum.totalAmount ?? 0,
          platformFees: revenue._sum.platformFee ?? 0,
        },
        chart,
        topSpecialties: topSpecialties.map((s) => ({ ...s, bookings: Number(s.bookings) })),
        recent,
      };
    });
  }

  async patients(q: PaginationDto) {
    const text = q.q?.trim();
    const where: Prisma.UserWhereInput = {
      role: Role.PATIENT,
      ...(text && { OR: [{ phone: { contains: text } }, { name: { contains: text, mode: 'insensitive' } }] }),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: {
          id: true, phone: true, name: true, email: true, status: true, createdAt: true, lastLoginAt: true,
          patient: { select: { gender: true, dateOfBirth: true } },
          _count: { select: { appointments: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
      this.prisma.user.count({ where }),
    ]);
    return paginate(items, total, q.page, q.limit);
  }

  async patient(id: string) {
    const user = await this.prisma.user.findFirst({
      where: { id, role: Role.PATIENT },
      select: {
        id: true, phone: true, name: true, email: true, status: true, createdAt: true, lastLoginAt: true,
        patient: true,
        appointments: {
          orderBy: { scheduledAt: 'desc' },
          take: 50,
          select: { id: true, code: true, status: true, type: true, scheduledAt: true, totalAmount: true, doctor: { select: { nameEn: true } } },
        },
      },
    });
    if (!user) throw new NotFoundException('Patient not found');
    return user;
  }

  staff() {
    return this.prisma.user.findMany({
      where: { role: { in: [Role.ADMIN, Role.SUPER_ADMIN, Role.CALL_AGENT, Role.DOCTOR_ASSISTANT] } },
      select: { id: true, name: true, email: true, role: true, status: true, lastLoginAt: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  async createStaff(dto: StaffDto, u: AuthUser, ip?: string) {
    const user = await this.prisma.user.create({
      data: { name: dto.name, email: dto.email.toLowerCase(), passwordHash: await bcrypt.hash(dto.password, 12), role: dto.role },
      select: { id: true, name: true, email: true, role: true, status: true },
    });
    await this.audit.log({ actorId: u.sub, action: 'staff.create', entity: 'users', entityId: user.id, after: user, ip });
    return user;
  }

  async setUserStatus(id: string, status: UserStatus, u: AuthUser, ip?: string) {
    if (id === u.sub) throw new ForbiddenException('You cannot change your own status');
    const target = await this.prisma.user.findUniqueOrThrow({ where: { id }, select: { role: true, status: true } });
    if (target.role === Role.SUPER_ADMIN && u.role !== Role.SUPER_ADMIN) throw new ForbiddenException();
    const user = await this.prisma.user.update({ where: { id }, data: { status }, select: { id: true, status: true } });
    if (status === UserStatus.SUSPENDED) {
      await this.prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    await this.audit.log({ actorId: u.sub, action: 'user.status', entity: 'users', entityId: id, before: { status: target.status }, after: { status }, ip });
    return user;
  }
}

@ApiTags('Admin · Dashboard')
@ApiBearerAuth()
@Roles(...ADMIN_ROLES)
@Controller('admin')
export class AdminController {
  constructor(
    private readonly svc: AdminService,
    private readonly audit: AuditService,
  ) {}

  @Get('dashboard') dashboard() { return this.svc.dashboard(); }

  @Get('patients') patients(@Query() q: PaginationDto) { return this.svc.patients(q); }
  @Get('patients/:id') patient(@Param('id', ParseUUIDPipe) id: string) { return this.svc.patient(id); }

  @Get('staff') staff() { return this.svc.staff(); }

  @Roles(Role.SUPER_ADMIN)
  @Post('staff') createStaff(@Body() dto: StaffDto, @CurrentUser() u: AuthUser, @ClientIp() ip: string) {
    return this.svc.createStaff(dto, u, ip);
  }

  @Patch('users/:id/status') userStatus(
    @Param('id', ParseUUIDPipe) id: string, @Body() dto: UserStatusDto, @CurrentUser() u: AuthUser, @ClientIp() ip: string,
  ) {
    return this.svc.setUserStatus(id, dto.status, u, ip);
  }

  @Get('audit-logs') auditLogs(@Query() q: AuditQuery) { return this.audit.list(q.page, q.limit, q.entity); }
}

@Module({ controllers: [AdminController], providers: [AdminService] })
export class AdminModule {}
