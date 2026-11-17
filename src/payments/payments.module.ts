import {
  BadRequestException,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Injectable,
  Logger,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { AppointmentStatus, CallRequestStatus, PaymentProvider, PaymentStatus, Prisma, Role, SlotStatus } from '@prisma/client';
import { randomBytes } from 'crypto';
import { AuditService } from '../audit/audit.service';
import { ADMIN_ROLES, AuthUser, ClientIp, CurrentUser, Roles } from '../common/decorators';
import { paginate, PaginationDto } from '../common/pagination';
import { shortCode } from '../common/utils';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.gateway';
import { PushService } from '../settings/push.service';

class AdminPaymentQuery extends PaginationDto {
  @ApiPropertyOptional({ enum: PaymentStatus }) @IsOptional() @IsEnum(PaymentStatus) status?: PaymentStatus;
}

const PAYMENT_SELECT = {
  id: true,
  code: true,
  provider: true,
  amount: true,
  serviceFee: true,
  platformFee: true,
  status: true,
  trxId: true,
  failureReason: true,
  paidAt: true,
  createdAt: true,
  appointmentId: true,
  callRequestId: true,
} satisfies Prisma.PaymentSelect;

/**
 * Payment flow (same shape for DEMO now and bKash later):
 *   1. POST /payments/appointments/:id  (or /payments/call-requests/:id) → INITIATED payment
 *   2. Gateway step:
 *        DEMO  → POST /payments/:id/demo-confirm   (server simulates a successful gateway result)
 *        BKASH → redirect to bKash, then the server verifies via bKash execute/query API (next phase)
 *   3. Only the server marks SUCCESS and confirms the booking — never the client.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  readonly provider: PaymentProvider;
  private readonly demoAllowed: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
    private readonly push: PushService,
    config: ConfigService,
  ) {
    this.provider = (config.get<string>('PAYMENT_PROVIDER') ?? 'demo').toUpperCase() === 'BKASH' ? PaymentProvider.BKASH : PaymentProvider.DEMO;
    this.demoAllowed = config.get('NODE_ENV') !== 'production' || config.get('ALLOW_DEMO_PAYMENTS') === 'true';
    if (this.provider === PaymentProvider.DEMO && !this.demoAllowed) {
      throw new Error('PAYMENT_PROVIDER=demo is not allowed in production');
    }
  }

  async initiateForAppointment(user: AuthUser, appointmentId: string) {
    const a = await this.prisma.appointment.findFirst({ where: { id: appointmentId, patientUserId: user.sub } });
    if (!a) throw new NotFoundException('Booking not found');
    if (a.status === AppointmentStatus.CONFIRMED) throw new ConflictException('This booking is already paid');
    if (a.status !== AppointmentStatus.PENDING_PAYMENT || !a.holdExpiresAt || a.holdExpiresAt < new Date()) {
      throw new BadRequestException('The reservation has expired. Please book the slot again');
    }
    return this.initiate(user.sub, { appointmentId: a.id }, a.totalAmount, a.serviceFee, a.platformFee);
  }

  async initiateForCallRequest(user: AuthUser, callRequestId: string) {
    const r = await this.prisma.callRequest.findFirst({ where: { id: callRequestId, patientUserId: user.sub } });
    if (!r) throw new NotFoundException('Call request not found');
    if (r.status !== CallRequestStatus.PAYMENT_PENDING) throw new ConflictException('This call request is already paid or closed');
    return this.initiate(user.sub, { callRequestId: r.id }, r.totalAmount, r.serviceFee, r.platformFee);
  }

  /** Re-uses an open INITIATED payment so double taps never create two charges. */
  private async initiate(userId: string, target: { appointmentId?: string; callRequestId?: string }, amount: number, serviceFee: number, platformFee: number) {
    const existing = await this.prisma.payment.findFirst({ where: { userId, ...target, status: PaymentStatus.INITIATED }, select: PAYMENT_SELECT });
    const payment =
      existing ??
      (await this.prisma.payment.create({
        data: { code: shortCode('PAY', 8), userId, ...target, provider: this.provider, amount, serviceFee, platformFee },
        select: PAYMENT_SELECT,
      }));
    return {
      payment,
      // For bKash this will carry the gateway URL; the demo provider completes on the next call.
      next: this.provider === PaymentProvider.DEMO ? { type: 'demo-confirm', path: `/payments/${payment.id}/demo-confirm` } : { type: 'redirect', url: null },
    };
  }

  /** DEMO provider only: simulates a verified successful gateway response, on the server. */
  async demoConfirm(user: AuthUser, paymentId: string, ip?: string) {
    if (this.provider !== PaymentProvider.DEMO || !this.demoAllowed) throw new ForbiddenException('Demo payments are disabled');
    const payment = await this.prisma.payment.findFirst({ where: { id: paymentId, userId: user.sub } });
    if (!payment) throw new NotFoundException('Payment not found');
    if (payment.status === PaymentStatus.SUCCESS) return this.result(payment.id);
    if (payment.status !== PaymentStatus.INITIATED) throw new BadRequestException('This payment is closed');

    const trxId = `DEMO${randomBytes(5).toString('hex').toUpperCase()}`;
    const ok = await this.prisma.$transaction(async (tx) => {
      if (payment.appointmentId) {
        // Confirm only if the hold is still valid — atomic, so an expired hold can never be confirmed.
        const { count } = await tx.appointment.updateMany({
          where: { id: payment.appointmentId, status: AppointmentStatus.PENDING_PAYMENT, holdExpiresAt: { gt: new Date() } },
          data: { status: AppointmentStatus.CONFIRMED, holdExpiresAt: null },
        });
        if (!count) return false;
        const a = await tx.appointment.findUniqueOrThrow({ where: { id: payment.appointmentId }, select: { slotId: true } });
        await tx.appointmentSlot.update({ where: { id: a.slotId }, data: { status: SlotStatus.BOOKED, holdExpiresAt: null } });
      }
      if (payment.callRequestId) {
        const { count } = await tx.callRequest.updateMany({
          where: { id: payment.callRequestId, status: CallRequestStatus.PAYMENT_PENDING },
          data: { status: CallRequestStatus.QUEUED, queuedAt: new Date() },
        });
        if (!count) return false;
      }
      await tx.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.SUCCESS, trxId, paidAt: new Date(), raw: { provider: 'DEMO', simulated: true } },
      });
      return true;
    });

    if (!ok) {
      await this.prisma.payment.update({ where: { id: payment.id }, data: { status: PaymentStatus.FAILED, failureReason: 'Reservation expired before payment' } });
      throw new ConflictException('The reservation expired before payment. No money was taken — please book again');
    }

    await this.audit.log({ actorId: user.sub, action: 'payment.success', entity: 'payments', entityId: payment.id, after: { amount: payment.amount, trxId, provider: 'DEMO' }, ip });
    if (payment.callRequestId) {
      this.realtime.toAgents('queue:changed', { callRequestId: payment.callRequestId });
      this.realtime.toUser(user.sub, 'callrequest:status', { id: payment.callRequestId, status: CallRequestStatus.QUEUED });
    }
    void this.push.sendToUser(user.sub, {
      title: 'পেমেন্ট সফল ✅',
      body: payment.appointmentId
        ? `৳${payment.amount} পরিশোধ হয়েছে। আপনার অ্যাপয়েন্টমেন্ট নিশ্চিত।`
        : `৳${payment.amount} পরিশোধ হয়েছে। এজেন্ট শীঘ্রই আপনার কল ধরবেন।`,
      data: { type: 'payment', paymentId: payment.id, ...(payment.appointmentId && { appointmentId: payment.appointmentId }) },
    });
    this.logger.log(`Payment ${payment.code} SUCCESS (demo) ৳${payment.amount}`);
    return this.result(payment.id);
  }

  private result(id: string) {
    return this.prisma.payment.findUniqueOrThrow({ where: { id }, select: PAYMENT_SELECT });
  }

  async mine(user: AuthUser, q: PaginationDto) {
    const where = { userId: user.sub };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.payment.findMany({ where, select: PAYMENT_SELECT, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit }),
      this.prisma.payment.count({ where }),
    ]);
    return paginate(items, total, q.page, q.limit);
  }

  async adminList(q: AdminPaymentQuery) {
    const text = q.q?.trim();
    const where: Prisma.PaymentWhereInput = {
      ...(q.status && { status: q.status }),
      ...(text && { OR: [{ code: { contains: text.toUpperCase() } }, { trxId: { contains: text.toUpperCase() } }, { user: { phone: { contains: text } } }] }),
    };
    const [items, total, sums] = await this.prisma.$transaction([
      this.prisma.payment.findMany({
        where,
        select: {
          ...PAYMENT_SELECT,
          user: { select: { name: true, phone: true } },
          appointment: { select: { code: true, doctor: { select: { nameEn: true } } } },
          callRequest: { select: { code: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
      this.prisma.payment.count({ where }),
      this.prisma.payment.aggregate({ where: { status: PaymentStatus.SUCCESS }, _sum: { amount: true, platformFee: true }, _count: true }),
    ]);
    return { ...paginate(items, total, q.page, q.limit), summary: { successCount: sums._count, collected: sums._sum.amount ?? 0, platformFees: sums._sum.platformFee ?? 0 } };
  }
}

@ApiTags('Payments')
@ApiBearerAuth()
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get('config')
  config() {
    return { provider: this.payments.provider };
  }

  @Roles(Role.PATIENT)
  @Post('appointments/:id')
  @HttpCode(200)
  forAppointment(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.payments.initiateForAppointment(u, id);
  }

  @Roles(Role.PATIENT)
  @Post('call-requests/:id')
  @HttpCode(200)
  forCallRequest(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.payments.initiateForCallRequest(u, id);
  }

  @Roles(Role.PATIENT)
  @Post(':id/demo-confirm')
  @HttpCode(200)
  demoConfirm(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip: string) {
    return this.payments.demoConfirm(u, id, ip);
  }

  @Roles(Role.PATIENT)
  @Get('me')
  mine(@CurrentUser() u: AuthUser, @Query() q: PaginationDto) {
    return this.payments.mine(u, q);
  }
}

@ApiTags('Admin · Payments')
@ApiBearerAuth()
@Roles(...ADMIN_ROLES)
@Controller('admin/payments')
export class AdminPaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get() list(@Query() q: AdminPaymentQuery) { return this.payments.adminList(q); }
}

@Module({ controllers: [PaymentsController, AdminPaymentsController], providers: [PaymentsService], exports: [PaymentsService] })
export class PaymentsModule {}
