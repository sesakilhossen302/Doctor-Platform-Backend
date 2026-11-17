import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppointmentStatus, ConsultationType, DoctorStatus, Prisma, SlotStatus, VerificationStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/decorators';
import { paginate } from '../common/pagination';
import { dhakaDateTime, shortCode } from '../common/utils';
import { SlotsService } from '../doctors/slots.service';
import { FeesService } from '../fees/fees.module';
import { PrismaService } from '../prisma/prisma.service';
import { AdminAppointmentQueryDto, AdminStatusDto, CreateAppointmentDto, MyAppointmentsQueryDto, QuoteDto } from './appointments.dto';

const MAX_ACTIVE_HOLDS_PER_PATIENT = 3;
const CLEANUP_INTERVAL_MS = 60_000;

export const APPOINTMENT_SELECT = {
  id: true,
  code: true,
  type: true,
  status: true,
  scheduledAt: true,
  endAt: true,
  holdExpiresAt: true,
  patientName: true,
  patientAge: true,
  patientGender: true,
  reason: true,
  serviceFee: true,
  platformFee: true,
  totalAmount: true,
  cancelledAt: true,
  cancelReason: true,
  createdAt: true,
  doctor: {
    select: {
      id: true,
      slug: true,
      nameEn: true,
      nameBn: true,
      photoUrl: true,
      degrees: true,
      isDemo: true,
      designation: { select: { nameEn: true, nameBn: true } },
      specialties: { where: { isPrimary: true }, select: { specialty: { select: { nameEn: true, nameBn: true } } } },
    },
  },
  chamber: {
    select: { id: true, name: true, address: true, district: { select: { nameEn: true, nameBn: true } } },
  },
} satisfies Prisma.AppointmentSelect;

/** Allowed manual status changes by admins. */
const ADMIN_TRANSITIONS: Partial<Record<AppointmentStatus, AppointmentStatus[]>> = {
  PENDING_PAYMENT: [AppointmentStatus.CANCELLED],
  CONFIRMED: [AppointmentStatus.COMPLETED, AppointmentStatus.NO_SHOW, AppointmentStatus.CANCELLED],
};

@Injectable()
export class AppointmentsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AppointmentsService.name);
  private readonly holdMinutes: number;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly slots: SlotsService,
    private readonly fees: FeesService,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    this.holdMinutes = Number(config.get('SLOT_HOLD_MINUTES') ?? 10);
  }

  // ─────────────────────────── Patient ───────────────────────────

  /** Fee breakdown shown on the checkout screen — calculated on the server, never on the client. */
  async quote(dto: QuoteDto) {
    const doctor = await this.bookableDoctor(dto.doctorId, dto.type);
    const serviceFee = dto.type === ConsultationType.CHAMBER ? doctor.chamberFee : doctor.onlineFee;
    return this.fees.calculate(FeesService.serviceTypeFor(dto.type), serviceFee);
  }

  /**
   * Books a slot in two atomic steps:
   *  1. Reserve the slot row (INSERT, or conditional UPDATE of a free/expired row).
   *     The UNIQUE(doctorId, startAt) constraint guarantees only one request can win,
   *     even with thousands of concurrent requests across many servers.
   *  2. Create the appointment as PENDING_PAYMENT with a hold that expires in SLOT_HOLD_MINUTES.
   * The appointment becomes CONFIRMED only after a server-verified payment (payments phase).
   */
  async create(user: AuthUser, dto: CreateAppointmentDto) {
    const doctor = await this.bookableDoctor(dto.doctorId, dto.type);

    const activeHolds = await this.prisma.appointment.count({
      where: { patientUserId: user.sub, status: AppointmentStatus.PENDING_PAYMENT, holdExpiresAt: { gt: new Date() } },
    });
    if (activeHolds >= MAX_ACTIVE_HOLDS_PER_PATIENT) {
      throw new BadRequestException('You have unpaid bookings in progress. Complete or cancel them first');
    }

    const slot = await this.slots.resolve(doctor.id, dto.startAt, dto.type);
    if (dto.type === ConsultationType.CHAMBER && !slot.chamberId) throw new BadRequestException('Not a chamber slot');

    const serviceFee = dto.type === ConsultationType.CHAMBER ? doctor.chamberFee : doctor.onlineFee;
    const fee = await this.fees.calculate(FeesService.serviceTypeFor(dto.type), serviceFee);
    const holdExpiresAt = new Date(Date.now() + this.holdMinutes * 60_000);
    const startAt = new Date(slot.startAt);
    const endAt = new Date(slot.endAt);

    const slotRow = await this.acquireSlot(doctor.id, startAt, endAt, dto.type, slot.chamberId, holdExpiresAt);

    try {
      const appointment = await this.prisma.appointment.create({
        data: {
          code: shortCode('DA'),
          patientUserId: user.sub,
          doctorId: doctor.id,
          slotId: slotRow.id,
          chamberId: dto.type === ConsultationType.CHAMBER ? slot.chamberId : null,
          type: dto.type,
          scheduledAt: startAt,
          endAt,
          holdExpiresAt,
          patientName: dto.patientName.trim(),
          patientAge: dto.patientAge,
          patientGender: dto.patientGender,
          reason: dto.reason?.trim(),
          serviceFee: fee.serviceFee,
          platformFee: fee.platformFee,
          totalAmount: fee.total,
        },
        select: APPOINTMENT_SELECT,
      });
      return { ...appointment, fee };
    } catch (e) {
      await this.releaseSlot(slotRow.id);
      throw e;
    }
  }

  async mine(user: AuthUser, q: MyAppointmentsQueryDto) {
    const now = new Date();
    const where: Prisma.AppointmentWhereInput = { patientUserId: user.sub };
    let orderBy: Prisma.AppointmentOrderByWithRelationInput = { scheduledAt: 'desc' };
    if (q.tab === 'upcoming') {
      where.status = { in: [AppointmentStatus.CONFIRMED, AppointmentStatus.PENDING_PAYMENT] };
      where.endAt = { gte: now };
      orderBy = { scheduledAt: 'asc' };
    } else if (q.tab === 'past') {
      where.OR = [
        { status: { in: [AppointmentStatus.COMPLETED, AppointmentStatus.NO_SHOW] } },
        { status: AppointmentStatus.CONFIRMED, endAt: { lt: now } },
      ];
    } else if (q.tab === 'cancelled') {
      where.status = { in: [AppointmentStatus.CANCELLED, AppointmentStatus.EXPIRED] };
    }
    const [items, total] = await this.prisma.$transaction([
      this.prisma.appointment.findMany({ where, select: APPOINTMENT_SELECT, orderBy, skip: (q.page - 1) * q.limit, take: q.limit }),
      this.prisma.appointment.count({ where }),
    ]);
    return paginate(items, total, q.page, q.limit);
  }

  async getMine(user: AuthUser, id: string) {
    const a = await this.prisma.appointment.findFirst({ where: { id, patientUserId: user.sub }, select: APPOINTMENT_SELECT });
    if (!a) throw new NotFoundException('Appointment not found');
    return a;
  }

  async cancelMine(user: AuthUser, id: string, reason?: string) {
    const a = await this.prisma.appointment.findFirst({ where: { id, patientUserId: user.sub } });
    if (!a) throw new NotFoundException('Appointment not found');
    if (a.status === AppointmentStatus.CONFIRMED) {
      // Paid bookings need the refund policy (payments phase) — not self-service yet.
      throw new ForbiddenException('Paid bookings can be cancelled through support');
    }
    if (a.status !== AppointmentStatus.PENDING_PAYMENT) throw new BadRequestException('This booking cannot be cancelled');
    return this.cancel(a.id, a.slotId, reason ?? 'Cancelled by patient', user);
  }

  // ─────────────────────────── Admin ───────────────────────────

  async adminList(q: AdminAppointmentQueryDto) {
    const where: Prisma.AppointmentWhereInput = {
      ...(q.status && { status: q.status }),
      ...(q.type && { type: q.type }),
      ...(q.doctorId && { doctorId: q.doctorId }),
      ...((q.from || q.to) && {
        scheduledAt: {
          ...(q.from && { gte: dhakaDateTime(q.from, '00:00') }),
          ...(q.to && { lt: new Date(dhakaDateTime(q.to, '00:00').getTime() + 86_400_000) }),
        },
      }),
      ...(q.q?.trim() && {
        OR: [
          { code: { contains: q.q.trim().toUpperCase() } },
          { patientName: { contains: q.q.trim(), mode: 'insensitive' } },
          { patient: { phone: { contains: q.q.trim() } } },
          { doctor: { nameEn: { contains: q.q.trim(), mode: 'insensitive' } } },
        ],
      }),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.appointment.findMany({
        where,
        select: { ...APPOINTMENT_SELECT, patient: { select: { id: true, phone: true, name: true } } },
        orderBy: { scheduledAt: 'desc' },
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
      this.prisma.appointment.count({ where }),
    ]);
    return paginate(items, total, q.page, q.limit);
  }

  async adminSetStatus(id: string, dto: AdminStatusDto, u: AuthUser, ip?: string) {
    const a = await this.prisma.appointment.findUnique({ where: { id } });
    if (!a) throw new NotFoundException('Appointment not found');
    if (!ADMIN_TRANSITIONS[a.status]?.includes(dto.status)) {
      throw new BadRequestException(`Cannot change ${a.status} to ${dto.status}`);
    }
    if (dto.status === AppointmentStatus.CANCELLED) return this.cancel(a.id, a.slotId, dto.reason ?? 'Cancelled by admin', u, ip);

    const updated = await this.prisma.appointment.update({ where: { id }, data: { status: dto.status }, select: APPOINTMENT_SELECT });
    await this.audit.log({ actorId: u.sub, action: 'appointment.status', entity: 'appointments', entityId: id, before: { status: a.status }, after: { status: dto.status, reason: dto.reason }, ip });
    return updated;
  }

  // ─────────────────────────── Internals ───────────────────────────

  private async bookableDoctor(doctorId: string, type: ConsultationType) {
    const doctor = await this.prisma.doctor.findFirst({
      where: { id: doctorId, status: DoctorStatus.ACTIVE, verificationStatus: VerificationStatus.VERIFIED },
      select: { id: true, onlineFee: true, chamberFee: true, consultationTypes: true },
    });
    if (!doctor) throw new NotFoundException('Doctor not found');
    if (!doctor.consultationTypes.includes(type)) throw new BadRequestException('This doctor does not offer that consultation type');
    return doctor;
  }

  private async acquireSlot(doctorId: string, startAt: Date, endAt: Date, type: ConsultationType, chamberId: string | null, holdExpiresAt: Date) {
    try {
      return await this.prisma.appointmentSlot.create({
        data: { doctorId, startAt, endAt, type, chamberId, status: SlotStatus.HELD, holdExpiresAt },
        select: { id: true },
      });
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
    }
    // Row exists: take it only if it is free or its previous hold has expired.
    const now = new Date();
    const { count } = await this.prisma.appointmentSlot.updateMany({
      where: {
        doctorId,
        startAt,
        OR: [{ status: SlotStatus.AVAILABLE }, { status: SlotStatus.HELD, holdExpiresAt: { lt: now } }],
      },
      data: { status: SlotStatus.HELD, holdExpiresAt, endAt, type, chamberId },
    });
    if (count === 0) throw new ConflictException('Someone just booked this slot. Please choose another time');

    const row = await this.prisma.appointmentSlot.findUniqueOrThrow({ where: { doctorId_startAt: { doctorId, startAt } }, select: { id: true } });
    // Any older unpaid booking on this slot has lost its hold.
    await this.prisma.appointment.updateMany({
      where: { slotId: row.id, status: AppointmentStatus.PENDING_PAYMENT },
      data: { status: AppointmentStatus.EXPIRED },
    });
    return row;
  }

  private async releaseSlot(slotId: string) {
    await this.prisma.appointmentSlot.update({ where: { id: slotId }, data: { status: SlotStatus.AVAILABLE, holdExpiresAt: null } }).catch(() => undefined);
  }

  private async cancel(id: string, slotId: string, reason: string, u: AuthUser, ip?: string) {
    const [updated] = await this.prisma.$transaction([
      this.prisma.appointment.update({
        where: { id },
        data: { status: AppointmentStatus.CANCELLED, cancelledAt: new Date(), cancelReason: reason, holdExpiresAt: null },
        select: APPOINTMENT_SELECT,
      }),
      this.prisma.appointmentSlot.update({ where: { id: slotId }, data: { status: SlotStatus.AVAILABLE, holdExpiresAt: null } }),
    ]);
    await this.audit.log({ actorId: u.sub, action: 'appointment.cancel', entity: 'appointments', entityId: id, after: { reason }, ip });
    return updated;
  }

  /** Expire unpaid holds and free their slots. Runs on one process only (PM2 instance 0). */
  async expireHolds() {
    const now = new Date();
    const expired = await this.prisma.appointment.updateMany({
      where: { status: AppointmentStatus.PENDING_PAYMENT, holdExpiresAt: { lt: now } },
      data: { status: AppointmentStatus.EXPIRED },
    });
    const freed = await this.prisma.appointmentSlot.updateMany({
      where: { status: SlotStatus.HELD, holdExpiresAt: { lt: now } },
      data: { status: SlotStatus.AVAILABLE, holdExpiresAt: null },
    });
    if (expired.count || freed.count) this.logger.log(`Expired ${expired.count} unpaid bookings, freed ${freed.count} slots`);
  }

  onModuleInit() {
    const instance = process.env.NODE_APP_INSTANCE;
    if (instance === undefined || instance === '0') {
      this.timer = setInterval(() => this.expireHolds().catch((e) => this.logger.error(e)), CLEANUP_INTERVAL_MS);
      this.timer.unref();
    }
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
}
