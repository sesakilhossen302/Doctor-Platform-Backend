import { Body, Controller, Get, HttpCode, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsUUID } from 'class-validator';
import { AppointmentStatus, ConsultationStatus, Prisma, Role } from '@prisma/client';
import { CacheService } from '../cache/cache.service';
import { AuthUser, CurrentUser, Roles } from '../common/decorators';
import { paginate, PaginationDto } from '../common/pagination';
import { dhakaDate, dhakaDateTime } from '../common/utils';
import { APPOINTMENT_SELECT } from '../appointments/appointments.service';
import { PrismaService } from '../prisma/prisma.service';
import { CONSULTATION_SELECT, ConsultationsService } from './consultations.service';

class StartDto {
  @ApiProperty() @IsUUID() appointmentId: string;
}

class AvailabilityDto {
  @ApiProperty() @IsBoolean() isAvailableNow: boolean;
}

class DoctorAppointmentsQuery extends PaginationDto {
  @ApiPropertyOptional({ enum: ['today', 'upcoming', 'past'] }) @IsOptional() @IsIn(['today', 'upcoming', 'past']) tab?: 'today' | 'upcoming' | 'past';
}

// ─────────── Patient & shared call endpoints ───────────

@ApiTags('Consultations')
@ApiBearerAuth()
@Controller('consultations')
export class ConsultationsController {
  constructor(private readonly svc: ConsultationsService) {}

  /** Patient starts the call for a paid online appointment → doctor's phone rings. */
  @Roles(Role.PATIENT)
  @Post()
  start(@CurrentUser() u: AuthUser, @Body() dto: StartDto) {
    return this.svc.startForAppointment(u, dto.appointmentId);
  }

  @Roles(Role.PATIENT)
  @Get('me')
  history(@CurrentUser() u: AuthUser, @Query() q: PaginationDto) {
    return this.svc.patientHistory(u, q);
  }

  @Get(':id')
  get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.get(u, id);
  }

  @Roles(Role.DOCTOR)
  @Post(':id/accept')
  @HttpCode(200)
  accept(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.accept(u, id);
  }

  @Roles(Role.DOCTOR)
  @Post(':id/reject')
  @HttpCode(200)
  reject(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.reject(u, id);
  }

  @Post(':id/end')
  @HttpCode(200)
  end(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.end(u, id);
  }
}

// ─────────── Doctor app ───────────

@Injectable()
export class DoctorPortalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async doctorFor(user: AuthUser) {
    const d = await this.prisma.doctor.findUnique({
      where: { userId: user.sub },
      select: {
        id: true,
        nameEn: true,
        nameBn: true,
        photoUrl: true,
        degrees: true,
        isAvailableNow: true,
        isDemo: true,
        status: true,
        verificationStatus: true,
        onlineFee: true,
        chamberFee: true,
        ratingAvg: true,
        ratingCount: true,
        consultationTypes: true,
        designation: { select: { nameEn: true, nameBn: true } },
        specialties: { where: { isPrimary: true }, select: { specialty: { select: { nameEn: true, nameBn: true } } } },
      },
    });
    if (!d) throw new NotFoundException('No doctor profile is linked to this account');
    return d;
  }

  async me(user: AuthUser) {
    const d = await this.doctorFor(user);
    const today = dhakaDate();
    const start = dhakaDateTime(today, '00:00');
    const end = new Date(start.getTime() + 86_400_000);
    const [todayCount, completedCount, ringing] = await Promise.all([
      this.prisma.appointment.count({ where: { doctorId: d.id, status: AppointmentStatus.CONFIRMED, scheduledAt: { gte: start, lt: end } } }),
      this.prisma.consultation.count({ where: { doctorId: d.id, status: ConsultationStatus.ENDED } }),
      this.prisma.consultation.findFirst({ where: { doctorId: d.id, status: ConsultationStatus.RINGING }, orderBy: { ringingAt: 'desc' }, select: CONSULTATION_SELECT }),
    ]);
    return { doctor: d, stats: { todayAppointments: todayCount, completedCalls: completedCount }, ringing };
  }

  async setAvailability(user: AuthUser, isAvailableNow: boolean) {
    const d = await this.doctorFor(user);
    await this.prisma.doctor.update({ where: { id: d.id }, data: { isAvailableNow } });
    await this.cache.bump('doctors');
    return { isAvailableNow };
  }

  async appointments(user: AuthUser, q: DoctorAppointmentsQuery) {
    const d = await this.doctorFor(user);
    const now = new Date();
    const today = dhakaDate();
    const start = dhakaDateTime(today, '00:00');
    const end = new Date(start.getTime() + 86_400_000);
    const where: Prisma.AppointmentWhereInput = { doctorId: d.id };
    let orderBy: Prisma.AppointmentOrderByWithRelationInput = { scheduledAt: 'asc' };
    if (q.tab === 'past') {
      where.status = { in: [AppointmentStatus.COMPLETED, AppointmentStatus.NO_SHOW] };
      orderBy = { scheduledAt: 'desc' };
    } else if (q.tab === 'today') {
      where.status = AppointmentStatus.CONFIRMED;
      where.scheduledAt = { gte: start, lt: end };
    } else {
      where.status = AppointmentStatus.CONFIRMED;
      where.endAt = { gte: new Date(now.getTime() - 60 * 60_000) };
    }
    const [items, total] = await this.prisma.$transaction([
      this.prisma.appointment.findMany({ where, select: { ...APPOINTMENT_SELECT, patient: { select: { phone: true } } }, orderBy, skip: (q.page - 1) * q.limit, take: q.limit }),
      this.prisma.appointment.count({ where }),
    ]);
    return paginate(items, total, q.page, q.limit);
  }

  async consultations(user: AuthUser, q: PaginationDto) {
    const d = await this.doctorFor(user);
    const where = { doctorId: d.id };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.consultation.findMany({ where, select: CONSULTATION_SELECT, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit }),
      this.prisma.consultation.count({ where }),
    ]);
    return paginate(items, total, q.page, q.limit);
  }
}

@ApiTags('Doctor app')
@ApiBearerAuth()
@Roles(Role.DOCTOR)
@Controller('doctor')
export class DoctorPortalController {
  constructor(private readonly svc: DoctorPortalService) {}

  @Get('me') me(@CurrentUser() u: AuthUser) { return this.svc.me(u); }
  @Patch('availability') availability(@CurrentUser() u: AuthUser, @Body() dto: AvailabilityDto) { return this.svc.setAvailability(u, dto.isAvailableNow); }
  @Get('appointments') appointments(@CurrentUser() u: AuthUser, @Query() q: DoctorAppointmentsQuery) { return this.svc.appointments(u, q); }
  @Get('consultations') consultations(@CurrentUser() u: AuthUser, @Query() q: PaginationDto) { return this.svc.consultations(u, q); }
}

@Module({
  controllers: [ConsultationsController, DoctorPortalController],
  providers: [ConsultationsService, DoctorPortalService],
  exports: [ConsultationsService],
})
export class ConsultationsModule {}
