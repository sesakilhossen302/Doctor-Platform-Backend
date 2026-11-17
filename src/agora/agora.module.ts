import { Controller, ForbiddenException, Get, Global, Injectable, Module, NotFoundException, Query, ServiceUnavailableException } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';
import { CallRequestStatus, ConsultationStatus } from '@prisma/client';
import { RtcRole, RtcTokenBuilder } from 'agora-token';
import { createHash } from 'crypto';
import { AuthUser, CurrentUser } from '../common/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';

const TOKEN_TTL_SECONDS = 2 * 60 * 60;

class TokenQuery {
  @ApiProperty() @IsString() @MaxLength(64) channel: string;
}

export interface RtcCredentials {
  appId: string;
  channel: string;
  token: string | null;
  uid: number;
  expiresIn: number;
}

/**
 * Issues Agora RTC tokens. The App Certificate never leaves the server.
 * A token is only issued to a user who is a participant of that exact channel
 * (patient, assigned agent, or the doctor of a ringing/ongoing consultation).
 */
@Injectable()
export class AgoraService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  /** Admin dashboard settings first, then AGORA_APP_ID / AGORA_APP_CERTIFICATE from .env. */
  private async creds() {
    const appId = (await this.settings.getOrEnv('agora.appId', 'AGORA_APP_ID')) ?? '';
    const certificate = (await this.settings.getOrEnv('agora.certificate', 'AGORA_APP_CERTIFICATE')) ?? '';
    return { appId, certificate };
  }

  async configured() {
    return (await this.creds()).appId.length > 0;
  }

  /** Stable numeric Agora uid per user (Agora needs a 32-bit unsigned int). */
  static uidFor(userId: string): number {
    return (parseInt(createHash('sha1').update(userId).digest('hex').slice(0, 8), 16) % 2_000_000_000) + 1;
  }

  async credentialsFor(user: AuthUser, channel: string): Promise<RtcCredentials> {
    const { appId, certificate } = await this.creds();
    if (!appId) {
      throw new ServiceUnavailableException('Video calling is not configured yet: add the Agora App ID in Admin → Settings → Integrations');
    }
    await this.assertParticipant(user, channel);
    const uid = AgoraService.uidFor(user.sub);
    // Without a certificate the project is in Agora "testing mode" (App ID only, no token).
    const token = certificate
      ? RtcTokenBuilder.buildTokenWithUid(appId, certificate, channel, uid, RtcRole.PUBLISHER, TOKEN_TTL_SECONDS, TOKEN_TTL_SECONDS)
      : null;
    return { appId, channel, token, uid, expiresIn: TOKEN_TTL_SECONDS };
  }

  private async assertParticipant(user: AuthUser, channel: string) {
    const live: ConsultationStatus[] = [ConsultationStatus.RINGING, ConsultationStatus.ONGOING];

    const request = await this.prisma.callRequest.findUnique({ where: { channelName: channel } });
    if (request) {
      const active: CallRequestStatus[] = [CallRequestStatus.CONNECTED, CallRequestStatus.TRANSFERRED];
      if (!active.includes(request.status)) throw new ForbiddenException('This call is not active');
      if (request.patientUserId === user.sub || request.agentId === user.sub) return;
      const doctorLeg = await this.prisma.consultation.findFirst({
        where: { callRequestId: request.id, status: { in: live }, doctor: { userId: user.sub } },
      });
      if (doctorLeg) return;
      throw new ForbiddenException('You are not part of this call');
    }

    const consultation = await this.prisma.consultation.findFirst({
      where: { channelName: channel, status: { in: live } },
      include: { doctor: { select: { userId: true } } },
    });
    if (!consultation) throw new NotFoundException('Call not found or already ended');
    if (consultation.patientUserId !== user.sub && consultation.doctor.userId !== user.sub) {
      throw new ForbiddenException('You are not part of this call');
    }
  }
}

@ApiTags('Calls')
@ApiBearerAuth()
@Controller('calls')
export class AgoraController {
  constructor(private readonly agora: AgoraService) {}

  /** Agora credentials for a channel the caller is allowed to join. */
  @Get('token')
  token(@CurrentUser() u: AuthUser, @Query() q: TokenQuery) {
    return this.agora.credentialsFor(u, q.channel);
  }

  @Get('config')
  async config() {
    return { configured: await this.agora.configured() };
  }
}

@Global()
@Module({ controllers: [AgoraController], providers: [AgoraService], exports: [AgoraService] })
export class AgoraModule {}
