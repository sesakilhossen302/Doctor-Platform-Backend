import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { CallMedia, CallRequestStatus, ConsultationStatus, ConsultationType, DoctorStatus, FeeServiceType, Prisma, Role, VerificationStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthUser, ClientIp, CurrentUser, Roles, STAFF_ROLES } from '../common/decorators';
import { shortCode } from '../common/utils';
import { ConsultationsModule } from '../consultations/consultations.module';
import { CONSULTATION_SELECT, ConsultationsService } from '../consultations/consultations.service';
import { FeesModule, FeesService } from '../fees/fees.module';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.gateway';
import { PushService } from '../settings/push.service';

class CreateCallRequestDto {
  @ApiPropertyOptional({ enum: CallMedia, default: CallMedia.AUDIO }) @IsOptional() @IsEnum(CallMedia) media?: CallMedia;
  @ApiPropertyOptional({ example: 'Fever for 2 days, need advice' }) @IsOptional() @IsString() @MaxLength(500) reason?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() specialtyId?: number;
}

class NotesDto {
  @ApiProperty() @IsString() @MaxLength(2000) notes: string;
}

class TransferDto {
  @ApiProperty() @IsUUID() doctorId: string;
}

class DoctorQuery {
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() specialtyId?: number;
}

const REQUEST_SELECT = {
  id: true,
  code: true,
  status: true,
  media: true,
  reason: true,
  priority: true,
  notes: true,
  channelName: true,
  serviceFee: true,
  platformFee: true,
  totalAmount: true,
  queuedAt: true,
  connectedAt: true,
  transferredAt: true,
  completedAt: true,
  createdAt: true,
  specialtyId: true,
  patient: { select: { id: true, name: true, phone: true } },
  agent: { select: { id: true, name: true } },
  consultations: { orderBy: { createdAt: 'asc' }, select: CONSULTATION_SELECT },
} satisfies Prisma.CallRequestSelect;

const ACTIVE: CallRequestStatus[] = [CallRequestStatus.QUEUED, CallRequestStatus.CONNECTED, CallRequestStatus.TRANSFERRED];

/**
 * Instant call through the call center:
 *   PAYMENT_PENDING → (payment) → QUEUED → agent accepts → CONNECTED
 *   → agent transfers → doctor rings → doctor accepts → TRANSFERRED → COMPLETED
 * Patient, agent and doctor all share one Agora channel, so the transfer is seamless.
 * Agents follow an approved, NON-diagnostic support script.
 */
@Injectable()
export class CallCenterService {
  private readonly serviceFee: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly fees: FeesService,
    private readonly realtime: RealtimeService,
    private readonly consultations: ConsultationsService,
    private readonly audit: AuditService,
    private readonly push: PushService,
    config: ConfigService,
  ) {
    this.serviceFee = Number(config.get('INSTANT_CALL_SERVICE_FEE') ?? 50);
  }

  // ─────────── Patient ───────────

  async quote() {
    return this.fees.calculate(FeeServiceType.INSTANT_CALL, this.serviceFee);
  }

  async create(user: AuthUser, dto: CreateCallRequestDto) {
    const open = await this.prisma.callRequest.findFirst({
      where: { patientUserId: user.sub, status: { in: [CallRequestStatus.PAYMENT_PENDING, ...ACTIVE] } },
      select: REQUEST_SELECT,
    });
    if (open) return open; // one open request per patient
    const fee = await this.quote();
    const code = shortCode('CR');
    return this.prisma.callRequest.create({
      data: {
        code,
        patientUserId: user.sub,
        media: dto.media ?? CallMedia.AUDIO,
        reason: dto.reason?.trim(),
        specialtyId: dto.specialtyId,
        channelName: `cr_${code.replace('-', '')}`,
        serviceFee: fee.serviceFee,
        platformFee: fee.platformFee,
        totalAmount: fee.total,
      },
      select: REQUEST_SELECT,
    });
  }

  async getMine(user: AuthUser, id: string) {
    const r = await this.prisma.callRequest.findFirst({ where: { id, patientUserId: user.sub }, select: REQUEST_SELECT });
    if (!r) throw new NotFoundException('Call request not found');
    const position =
      r.status === CallRequestStatus.QUEUED && r.queuedAt
        ? (await this.prisma.callRequest.count({ where: { status: CallRequestStatus.QUEUED, queuedAt: { lt: r.queuedAt } } })) + 1
        : null;
    return { ...r, queuePosition: position };
  }

  async cancelMine(user: AuthUser, id: string) {
    const { count } = await this.prisma.callRequest.updateMany({
      where: { id, patientUserId: user.sub, status: { in: [CallRequestStatus.PAYMENT_PENDING, CallRequestStatus.QUEUED] } },
      data: { status: CallRequestStatus.CANCELLED, completedAt: new Date() },
    });
    if (!count) throw new BadRequestException('This call can no longer be cancelled');
    this.realtime.toAgents('queue:changed', { callRequestId: id });
    return { success: true };
  }

  /** Patient hangs up an active call. */
  async hangUp(user: AuthUser, id: string) {
    const r = await this.prisma.callRequest.findFirst({ where: { id, patientUserId: user.sub } });
    if (!r) throw new NotFoundException('Call request not found');
    return this.finish(r.id, user);
  }

  // ─────────── Agent ───────────

  queue() {
    return this.prisma.callRequest.findMany({
      where: { status: { in: ACTIVE } },
      select: REQUEST_SELECT,
      orderBy: [{ priority: 'desc' }, { queuedAt: 'asc' }],
      take: 100,
    });
  }

  history() {
    return this.prisma.callRequest.findMany({
      where: { status: { in: [CallRequestStatus.COMPLETED, CallRequestStatus.CANCELLED, CallRequestStatus.FAILED] } },
      select: REQUEST_SELECT,
      orderBy: { updatedAt: 'desc' },
      take: 30,
    });
  }

  async accept(user: AuthUser, id: string, ip?: string) {
    const { count } = await this.prisma.callRequest.updateMany({
      where: { id, status: CallRequestStatus.QUEUED },
      data: { status: CallRequestStatus.CONNECTED, agentId: user.sub, connectedAt: new Date() },
    });
    if (!count) throw new BadRequestException('Another agent already took this call');
    const r = await this.prisma.callRequest.findUniqueOrThrow({ where: { id }, select: REQUEST_SELECT });
    this.realtime.toUser(r.patient.id, 'callrequest:status', { id, status: r.status, channelName: r.channelName });
    this.realtime.toAgents('queue:changed', { callRequestId: id });
    void this.push.sendToUser(r.patient.id, {
      title: '📞 এজেন্ট আপনার কল ধরেছেন',
      body: 'কলে যোগ দিতে ট্যাপ করুন।',
      data: { type: 'callrequest', callRequestId: id },
      channel: 'calls',
    });
    await this.audit.log({ actorId: user.sub, action: 'callrequest.accept', entity: 'call_requests', entityId: id, ip });
    return r;
  }

  async notes(user: AuthUser, id: string, notes: string) {
    const r = await this.assignedTo(user, id);
    return this.prisma.callRequest.update({ where: { id: r.id }, data: { notes }, select: REQUEST_SELECT });
  }

  availableDoctors(specialtyId?: number) {
    return this.prisma.doctor.findMany({
      where: {
        status: DoctorStatus.ACTIVE,
        verificationStatus: VerificationStatus.VERIFIED,
        isAvailableNow: true,
        userId: { not: null },
        consultationTypes: { hasSome: [ConsultationType.ONLINE_AUDIO, ConsultationType.ONLINE_VIDEO] },
        ...(specialtyId && { specialties: { some: { specialtyId } } }),
        // not already in a call
        consultations: { none: { status: { in: [ConsultationStatus.RINGING, ConsultationStatus.ONGOING] } } },
      },
      select: {
        id: true,
        nameEn: true,
        nameBn: true,
        photoUrl: true,
        isDemo: true,
        designation: { select: { nameEn: true } },
        specialties: { select: { isPrimary: true, specialty: { select: { id: true, nameEn: true } } } },
      },
      orderBy: { ratingAvg: 'desc' },
      take: 50,
    });
  }

  async transfer(user: AuthUser, id: string, doctorId: string, ip?: string) {
    const r = await this.assignedTo(user, id);
    if (r.status !== CallRequestStatus.CONNECTED && r.status !== CallRequestStatus.TRANSFERRED) throw new BadRequestException('Accept the call before transferring');
    const ringing = await this.prisma.consultation.findFirst({ where: { callRequestId: id, status: ConsultationStatus.RINGING } });
    if (ringing) throw new BadRequestException('A doctor is already being called');
    const available = await this.availableDoctors();
    if (!available.some((d) => d.id === doctorId)) throw new BadRequestException('This doctor is not available right now');

    const c = await this.consultations.startForTransfer(id, doctorId, r.media, r.patientUserId, r.channelName);
    await this.audit.log({ actorId: user.sub, action: 'callrequest.transfer', entity: 'call_requests', entityId: id, after: { doctorId }, ip });
    return c;
  }

  async complete(user: AuthUser, id: string) {
    await this.assignedTo(user, id);
    return this.finish(id, user);
  }

  /** Closes the request and every doctor leg still live. */
  private async finish(id: string, user: AuthUser) {
    const live = await this.prisma.consultation.findMany({
      where: { callRequestId: id, status: { in: [ConsultationStatus.RINGING, ConsultationStatus.ONGOING] } },
      select: { id: true, doctor: { select: { userId: true } } },
    });
    for (const c of live) {
      // End as the doctor/patient would; ignore permission since this is a system close.
      await this.consultations.end({ sub: c.doctor.userId!, role: Role.DOCTOR }, c.id).catch(() => undefined);
    }
    const { count } = await this.prisma.callRequest.updateMany({
      where: { id, status: { in: ACTIVE } },
      data: { status: CallRequestStatus.COMPLETED, completedAt: new Date() },
    });
    const r = await this.prisma.callRequest.findUniqueOrThrow({ where: { id }, select: REQUEST_SELECT });
    if (count) {
      this.realtime.toUser(r.patient.id, 'callrequest:status', { id, status: r.status });
      this.realtime.toUser(r.agent?.id, 'callrequest:status', { id, status: r.status });
      this.realtime.toAgents('queue:changed', { callRequestId: id });
      await this.audit.log({ actorId: user.sub, action: 'callrequest.complete', entity: 'call_requests', entityId: id });
    }
    return r;
  }

  private async assignedTo(user: AuthUser, id: string) {
    const r = await this.prisma.callRequest.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Call request not found');
    const isAdmin = user.role === Role.ADMIN || user.role === Role.SUPER_ADMIN;
    if (r.agentId !== user.sub && !isAdmin) throw new ForbiddenException('This call is handled by another agent');
    return r;
  }
}

@ApiTags('Call requests (patient)')
@ApiBearerAuth()
@Roles(Role.PATIENT)
@Controller('call-requests')
export class CallRequestsController {
  constructor(private readonly svc: CallCenterService) {}

  @Get('quote') quote() { return this.svc.quote(); }
  @Post() create(@CurrentUser() u: AuthUser, @Body() dto: CreateCallRequestDto) { return this.svc.create(u, dto); }
  @Get('me/:id') get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.getMine(u, id); }
  @Post('me/:id/cancel') @HttpCode(200) cancel(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.cancelMine(u, id); }
  @Post('me/:id/hang-up') @HttpCode(200) hangUp(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.hangUp(u, id); }
}

@ApiTags('Call center (agent)')
@ApiBearerAuth()
@Roles(...STAFF_ROLES)
@Controller('call-center')
export class CallCenterController {
  constructor(private readonly svc: CallCenterService) {}

  @Get('queue') queue() { return this.svc.queue(); }
  @Get('history') history() { return this.svc.history(); }
  @Get('doctors') doctors(@Query() q: DoctorQuery) { return this.svc.availableDoctors(q.specialtyId); }
  @Post(':id/accept') @HttpCode(200) accept(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip: string) { return this.svc.accept(u, id, ip); }
  @Patch(':id/notes') notes(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: NotesDto) { return this.svc.notes(u, id, dto.notes); }
  @Post(':id/transfer') @HttpCode(200) transfer(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TransferDto, @ClientIp() ip: string) {
    return this.svc.transfer(u, id, dto.doctorId, ip);
  }
  @Post(':id/complete') @HttpCode(200) complete(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.complete(u, id); }
}

@Module({
  imports: [FeesModule, ConsultationsModule],
  controllers: [CallRequestsController, CallCenterController],
  providers: [CallCenterService],
})
export class CallCenterModule {}
