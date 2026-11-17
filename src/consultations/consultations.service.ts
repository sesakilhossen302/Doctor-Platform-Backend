import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AppointmentStatus,
  CallMedia,
  CallRequestStatus,
  ConsultationStatus,
  ConsultationType,
  Prisma,
  Role,
} from '@prisma/client';
import { randomBytes } from 'crypto';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/decorators';
import { paginate, PaginationDto } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.gateway';
import { PushService } from '../settings/push.service';

/** How long a call rings before it is marked MISSED. */
const RING_TIMEOUT_MS = 45_000;
/** Patients may start an appointment call this long before / after the slot. */
const JOIN_EARLY_MIN = 15;
const JOIN_LATE_MIN = 60;

export const CONSULTATION_SELECT = {
  id: true,
  media: true,
  channelName: true,
  status: true,
  ringingAt: true,
  acceptedAt: true,
  endedAt: true,
  durationSec: true,
  appointmentId: true,
  callRequestId: true,
  patient: { select: { id: true, name: true, phone: true } },
  doctor: {
    select: {
      id: true,
      nameEn: true,
      nameBn: true,
      photoUrl: true,
      userId: true,
      designation: { select: { nameBn: true, nameEn: true } },
      specialties: { where: { isPrimary: true }, select: { specialty: { select: { nameEn: true, nameBn: true } } } },
    },
  },
  appointment: { select: { code: true, patientName: true, patientAge: true, reason: true, scheduledAt: true } },
  callRequest: { select: { code: true, reason: true, notes: true, agentId: true } },
} satisfies Prisma.ConsultationSelect;

type ConsultationView = Prisma.ConsultationGetPayload<{ select: typeof CONSULTATION_SELECT }>;

/**
 * Doctor ↔ patient call state machine:
 *   RINGING → ONGOING (doctor accepts) → ENDED
 *   RINGING → REJECTED | MISSED (timeout) | CANCELLED (caller hangs up)
 * Every transition is a conditional UPDATE, so two clicks can never both win.
 */
@Injectable()
export class ConsultationsService {
  private readonly logger = new Logger(ConsultationsService.name);
  private readonly joinAnytime: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly audit: AuditService,
    private readonly push: PushService,
    config: ConfigService,
  ) {
    // Demo convenience: allow calling a confirmed online appointment at any time.
    this.joinAnytime = config.get('CONSULT_JOIN_ANYTIME') === 'true' && config.get('NODE_ENV') !== 'production';
  }

  // ─────────── Patient: call the doctor of a paid online appointment ───────────

  async startForAppointment(user: AuthUser, appointmentId: string) {
    const a = await this.prisma.appointment.findFirst({
      where: { id: appointmentId, patientUserId: user.sub },
      include: { doctor: { select: { id: true, userId: true } } },
    });
    if (!a) throw new NotFoundException('Booking not found');
    if (a.type === ConsultationType.CHAMBER) throw new BadRequestException('Chamber visits are in person — no call for this booking');
    if (a.status !== AppointmentStatus.CONFIRMED) throw new BadRequestException('Please complete payment before starting the call');
    if (!a.doctor.userId) throw new BadRequestException('This doctor has not activated the doctor app yet');

    if (!this.joinAnytime) {
      const now = Date.now();
      if (now < a.scheduledAt.getTime() - JOIN_EARLY_MIN * 60_000) throw new BadRequestException(`You can join ${JOIN_EARLY_MIN} minutes before your appointment`);
      if (now > a.endAt.getTime() + JOIN_LATE_MIN * 60_000) throw new BadRequestException('This appointment time has passed');
    }

    const live = await this.prisma.consultation.findFirst({
      where: { appointmentId: a.id, status: { in: [ConsultationStatus.RINGING, ConsultationStatus.ONGOING] } },
      select: CONSULTATION_SELECT,
    });
    if (live) return live;

    const c = await this.prisma.consultation.create({
      data: {
        appointmentId: a.id,
        patientUserId: user.sub,
        doctorId: a.doctor.id,
        media: a.type === ConsultationType.ONLINE_AUDIO ? CallMedia.AUDIO : CallMedia.VIDEO,
        channelName: `apt_${a.code.replace('-', '')}_${randomBytes(3).toString('hex')}`,
      },
      select: CONSULTATION_SELECT,
    });
    this.ring(c);
    return c;
  }

  // ─────────── Call-center transfer: ring a doctor into an existing call ───────────

  async startForTransfer(callRequestId: string, doctorId: string, media: CallMedia, patientUserId: string, channelName: string) {
    const c = await this.prisma.consultation.create({
      data: { callRequestId, doctorId, media, patientUserId, channelName },
      select: CONSULTATION_SELECT,
    });
    this.ring(c);
    return c;
  }

  private ring(c: ConsultationView) {
    this.realtime.toUser(c.doctor.userId, 'call:incoming', c);
    // Push reaches the doctor's phone even when the app is in the background or closed.
    const patientName = c.appointment?.patientName ?? c.patient.name ?? 'রোগী';
    void this.push.sendToUser(c.doctor.userId, {
      title: c.media === CallMedia.VIDEO ? '📹 ভিডিও কল আসছে' : '📞 অডিও কল আসছে',
      body: `${patientName} আপনাকে কল করছেন${c.callRequestId ? ' (কল সেন্টার থেকে)' : ''}। ধরতে ট্যাপ করুন।`,
      data: { type: 'call', consultationId: c.id },
      channel: 'calls',
    });
    setTimeout(() => this.markMissed(c.id).catch((e) => this.logger.error(e)), RING_TIMEOUT_MS).unref();
  }

  private async markMissed(id: string) {
    const { count } = await this.prisma.consultation.updateMany({
      where: { id, status: ConsultationStatus.RINGING },
      data: { status: ConsultationStatus.MISSED, endedAt: new Date() },
    });
    if (count) await this.broadcast(id);
  }

  // ─────────── Transitions ───────────

  async accept(user: AuthUser, id: string) {
    const c = await this.forDoctor(user, id);
    const { count } = await this.prisma.consultation.updateMany({
      where: { id, status: ConsultationStatus.RINGING },
      data: { status: ConsultationStatus.ONGOING, acceptedAt: new Date() },
    });
    if (!count) throw new BadRequestException('This call is no longer ringing');
    if (c.callRequestId) {
      await this.prisma.callRequest.update({
        where: { id: c.callRequestId },
        data: { status: CallRequestStatus.TRANSFERRED, transferredAt: new Date() },
      });
      this.realtime.toAgents('queue:changed', { callRequestId: c.callRequestId });
    }
    return this.broadcast(id);
  }

  async reject(user: AuthUser, id: string) {
    await this.forDoctor(user, id);
    const { count } = await this.prisma.consultation.updateMany({
      where: { id, status: ConsultationStatus.RINGING },
      data: { status: ConsultationStatus.REJECTED, endedAt: new Date(), endedBy: 'doctor' },
    });
    if (!count) throw new BadRequestException('This call is no longer ringing');
    return this.broadcast(id);
  }

  /** Hang up — by any participant. Ringing calls become CANCELLED, ongoing calls ENDED. */
  async end(user: AuthUser, id: string) {
    const c = await this.prisma.consultation.findUnique({ where: { id }, include: { doctor: { select: { userId: true } }, callRequest: { select: { agentId: true } } } });
    if (!c) throw new NotFoundException('Call not found');
    const role = c.patientUserId === user.sub ? 'patient' : c.doctor.userId === user.sub ? 'doctor' : c.callRequest?.agentId === user.sub ? 'agent' : null;
    if (!role) throw new ForbiddenException('You are not part of this call');

    const now = new Date();
    if (c.status === ConsultationStatus.RINGING) {
      await this.prisma.consultation.updateMany({ where: { id, status: ConsultationStatus.RINGING }, data: { status: ConsultationStatus.CANCELLED, endedAt: now, endedBy: role } });
    } else if (c.status === ConsultationStatus.ONGOING) {
      const durationSec = c.acceptedAt ? Math.round((now.getTime() - c.acceptedAt.getTime()) / 1000) : 0;
      const { count } = await this.prisma.consultation.updateMany({
        where: { id, status: ConsultationStatus.ONGOING },
        data: { status: ConsultationStatus.ENDED, endedAt: now, durationSec, endedBy: role },
      });
      // A completed doctor call closes the appointment.
      if (count && c.appointmentId) {
        await this.prisma.appointment.updateMany({ where: { id: c.appointmentId, status: AppointmentStatus.CONFIRMED }, data: { status: AppointmentStatus.COMPLETED } });
      }
      if (count) await this.audit.log({ actorId: user.sub, action: 'consultation.end', entity: 'consultations', entityId: id, after: { durationSec, endedBy: role } });
    }
    return this.broadcast(id);
  }

  /** Sends the latest state to everyone in the call. */
  private async broadcast(id: string) {
    const c = await this.prisma.consultation.findUniqueOrThrow({ where: { id }, select: CONSULTATION_SELECT });
    const payload = { id: c.id, status: c.status, channelName: c.channelName, durationSec: c.durationSec, callRequestId: c.callRequestId };
    this.realtime.toUser(c.patient.id, 'call:status', payload);
    this.realtime.toUser(c.doctor.userId, 'call:status', payload);
    if (c.callRequest?.agentId) this.realtime.toUser(c.callRequest.agentId, 'call:status', payload);
    return c;
  }

  // ─────────── Reads ───────────

  async get(user: AuthUser, id: string) {
    const c = await this.prisma.consultation.findUnique({ where: { id }, select: CONSULTATION_SELECT });
    if (!c) throw new NotFoundException('Call not found');
    const staff = user.role === Role.ADMIN || user.role === Role.SUPER_ADMIN || c.callRequest?.agentId === user.sub;
    if (c.patient.id !== user.sub && c.doctor.userId !== user.sub && !staff) throw new ForbiddenException();
    return c;
  }

  async patientHistory(user: AuthUser, q: PaginationDto) {
    const where = { patientUserId: user.sub };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.consultation.findMany({ where, select: CONSULTATION_SELECT, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit }),
      this.prisma.consultation.count({ where }),
    ]);
    return paginate(items, total, q.page, q.limit);
  }

  private async forDoctor(user: AuthUser, id: string) {
    const c = await this.prisma.consultation.findUnique({ where: { id }, include: { doctor: { select: { userId: true } } } });
    if (!c) throw new NotFoundException('Call not found');
    if (c.doctor.userId !== user.sub) throw new ForbiddenException('Only the called doctor can do this');
    return c;
  }
}
