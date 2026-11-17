import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Role, User, UserStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'crypto';
import { ADMIN_ROLES, STAFF_ROLES } from '../common/decorators';
import { normalizeBdPhone } from '../common/utils';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../settings/mail.service';
import { RequestOtpDto, VerifyOtpDto } from './auth.dto';

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const MAX_OTP_ATTEMPTS = 5;
const OTP_RESEND_SECONDS = 60;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly otpDevMode: boolean;
  private readonly otpTtl: number;
  private readonly refreshDays: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly mail: MailService,
    config: ConfigService,
  ) {
    this.otpDevMode = config.get('OTP_DEV_MODE') === 'true';
    this.otpTtl = Number(config.get('OTP_TTL_SECONDS') ?? 300);
    this.refreshDays = Number(config.get('REFRESH_TOKEN_TTL_DAYS') ?? 30);
    if (this.otpDevMode && config.get('NODE_ENV') === 'production') {
      throw new Error('OTP_DEV_MODE must be false in production');
    }
  }

  // ─────────── Patient OTP login ───────────

  /**
   * Sends a 6-digit code to a phone number or an email address.
   *  - Email: sent through the Gmail account configured in admin settings (random code).
   *  - Phone: SMS provider not connected yet → only works in OTP_DEV_MODE (code 123456).
   *  - Email without Gmail configured → OTP_DEV_MODE fallback (code 123456) or an error.
   */
  async requestOtp(dto: RequestOtpDto) {
    const { identifier, kind } = this.identifierOrThrow(dto);
    // `phone` column stores the login identifier (phone number or email).
    const last = await this.prisma.otpCode.findFirst({ where: { phone: identifier }, orderBy: { createdAt: 'desc' } });
    if (last && Date.now() - last.createdAt.getTime() < OTP_RESEND_SECONDS * 1000) {
      throw new HttpException('Please wait a minute before requesting another code', HttpStatus.TOO_MANY_REQUESTS);
    }

    const sendEmail = kind === 'email' && (await this.mail.configured());
    if (!sendEmail && !this.otpDevMode) {
      throw new ServiceUnavailableException(
        kind === 'email' ? 'Email login is not available yet. Please try again later.' : 'SMS login is not available yet. Please log in with your email.',
      );
    }
    const code = sendEmail ? String(randomInt(0, 1_000_000)).padStart(6, '0') : '123456';
    await this.prisma.otpCode.create({
      data: { phone: identifier, codeHash: sha256(`${identifier}:${code}`), expiresAt: new Date(Date.now() + this.otpTtl * 1000) },
    });

    if (sendEmail) {
      try {
        await this.mail.sendOtp(identifier, code);
      } catch (e) {
        this.logger.error(`OTP email failed: ${(e as Error).message}`);
        throw new ServiceUnavailableException('Could not send the email right now. Please try again');
      }
    }
    return { sent: true, channel: sendEmail ? 'email' : 'demo', expiresInSeconds: this.otpTtl, ...(sendEmail ? {} : { devCode: code }) };
  }

  async verifyOtp(dto: VerifyOtpDto) {
    const { identifier, kind } = this.identifierOrThrow(dto);
    const code = dto.code;
    const otp = await this.prisma.otpCode.findFirst({
      where: { phone: identifier, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!otp) throw new BadRequestException('Code expired. Please request a new one');
    if (otp.attempts >= MAX_OTP_ATTEMPTS) throw new ForbiddenException('Too many attempts. Please request a new code');

    const expected = Buffer.from(otp.codeHash);
    const given = Buffer.from(sha256(`${identifier}:${code}`));
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      await this.prisma.otpCode.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
      throw new BadRequestException('Incorrect code');
    }
    await this.prisma.otpCode.update({ where: { id: otp.id }, data: { consumedAt: new Date() } });

    const where = kind === 'email' ? { email: identifier } : { phone: identifier };
    let user = await this.prisma.user.findUnique({ where });
    const isNewUser = !user;
    if (!user) {
      user = await this.prisma.user.create({
        data: { ...where, role: Role.PATIENT, patient: { create: { consentAt: new Date() } } },
      });
    }
    // Staff accounts use the password login on the dashboard, not OTP.
    if (STAFF_ROLES.includes(user.role)) throw new ForbiddenException('Staff accounts sign in on the admin dashboard');
    this.assertActive(user);
    return { ...(await this.issueTokens(user)), isNewUser };
  }

  // ─────────── Staff (admin / agent) password login ───────────

  async adminLogin(email: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    // Same error for unknown email and wrong password (no user enumeration).
    if (!user?.passwordHash || !STAFF_ROLES.includes(user.role)) throw new UnauthorizedException('Invalid email or password');
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw new UnauthorizedException('Invalid email or password');
    this.assertActive(user);
    return this.issueTokens(user);
  }

  // ─────────── Tokens ───────────

  async refresh(refreshToken: string) {
    const [id, secret] = refreshToken.split('.');
    if (!id || !secret) throw new UnauthorizedException('Invalid refresh token');
    const stored = await this.prisma.refreshToken.findUnique({ where: { id }, include: { user: true } });
    if (!stored || stored.revokedAt || stored.expiresAt < new Date() || stored.tokenHash !== sha256(secret)) {
      throw new UnauthorizedException('Session expired. Please log in again');
    }
    this.assertActive(stored.user);
    // Rotation: each refresh token can be used exactly once.
    await this.prisma.refreshToken.update({ where: { id }, data: { revokedAt: new Date() } });
    return this.issueTokens(stored.user);
  }

  async logout(refreshToken: string) {
    const [id] = refreshToken.split('.');
    if (id) await this.prisma.refreshToken.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date() } });
    return { success: true };
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, phone: true, email: true, name: true, role: true, status: true, createdAt: true, patient: true },
    });
    if (!user) throw new UnauthorizedException();
    return user;
  }

  private async issueTokens(user: User) {
    const accessToken = await this.jwt.signAsync({ sub: user.id, role: user.role });
    const secret = randomBytes(32).toString('base64url');
    const stored = await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: sha256(secret),
        expiresAt: new Date(Date.now() + this.refreshDays * 86_400_000),
      },
    });
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    return {
      accessToken,
      refreshToken: `${stored.id}.${secret}`,
      user: { id: user.id, name: user.name, phone: user.phone, email: user.email, role: user.role, isAdmin: ADMIN_ROLES.includes(user.role) },
    };
  }

  private assertActive(user: User) {
    if (user.status !== UserStatus.ACTIVE) throw new ForbiddenException('This account is suspended');
  }

  private identifierOrThrow(dto: RequestOtpDto): { identifier: string; kind: 'phone' | 'email' } {
    if (dto.email) return { identifier: dto.email.trim().toLowerCase(), kind: 'email' };
    const phone = normalizeBdPhone(dto.phone ?? '');
    if (!phone) throw new BadRequestException('Enter a valid Bangladeshi mobile number');
    return { identifier: phone, kind: 'phone' };
  }
}
