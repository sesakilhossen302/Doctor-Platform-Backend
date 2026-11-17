import { BadRequestException, Body, Controller, Get, Global, HttpCode, Module, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsEmail, IsIn, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { RtcRole, RtcTokenBuilder } from 'agora-token';
import { ADMIN_ROLES, AuthUser, ClientIp, CurrentUser, Public, Roles } from '../common/decorators';
import { MailService } from './mail.service';
import { PushService } from './push.service';
import { SETTING_KEYS, SettingKey, SettingsService } from './settings.service';

class SaveSettingsDto {
  @ApiProperty({ description: 'Map of setting key → value. Omit a key to keep it, send "" to clear it.' })
  @IsObject()
  values: Record<string, string>;
}

class TestEmailDto {
  @ApiProperty() @IsEmail() to: string;
}

class DeviceDto {
  @ApiProperty() @IsString() @MaxLength(4096) token: string;
  @ApiProperty({ enum: ['android', 'ios', 'web'] }) @IsIn(['android', 'ios', 'web']) platform: string;
}

class AppConfigQuery {
  @ApiPropertyOptional({ enum: ['android', 'ios', 'web'] }) @IsOptional() @IsIn(['android', 'ios', 'web']) platform?: string;
}

@ApiTags('Admin · Settings')
@ApiBearerAuth()
@Roles(...ADMIN_ROLES)
@Controller('admin/settings')
export class AdminSettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly mail: MailService,
    private readonly push: PushService,
  ) {}

  /** Current integration settings. Secret values are never returned — only whether they are set. */
  @Get('integrations')
  async get() {
    return {
      settings: await this.settings.masked(),
      status: {
        agora: !!(await this.settings.getOrEnv('agora.appId', 'AGORA_APP_ID')),
        email: await this.mail.configured(),
        push: await this.push.configured(),
      },
    };
  }

  @Put('integrations')
  async save(@Body() dto: SaveSettingsDto, @CurrentUser() u: AuthUser, @ClientIp() ip: string) {
    const unknown = Object.keys(dto.values).filter((k) => !(k in SETTING_KEYS));
    if (unknown.length) throw new BadRequestException(`Unknown setting(s): ${unknown.join(', ')}`);
    const sa = dto.values['firebase.serviceAccount'];
    if (sa) {
      try {
        const parsed = JSON.parse(sa);
        if (!parsed.private_key || !parsed.client_email || !parsed.project_id) throw new Error();
      } catch {
        throw new BadRequestException('Service account must be the full JSON file downloaded from Firebase (with project_id, client_email, private_key)');
      }
    }
    const appId = dto.values['agora.appId'];
    if (appId && !/^[0-9a-f]{32}$/i.test(appId.trim())) throw new BadRequestException('Agora App ID is a 32-character hexadecimal string');
    const certificate = dto.values['agora.certificate'];
    if (certificate && !/^[0-9a-f]{32}$/i.test(certificate.trim())) throw new BadRequestException('Agora App Certificate is a 32-character hexadecimal string');
    const changed = await this.settings.save(dto.values as Partial<Record<SettingKey, string>>, u.sub, ip);
    return { changed, ...(await this.get()) };
  }

  @Post('test/email')
  @HttpCode(200)
  async testEmail(@Body() dto: TestEmailDto) {
    try {
      await this.mail.verify();
      await this.mail.send(dto.to, 'পরীক্ষামূলক ইমেইল — Doctor Platform', '<p>Gmail সঠিকভাবে যুক্ত হয়েছে ✅<br/>Gmail is connected correctly.</p>', 'Gmail is connected correctly.');
      return { ok: true, message: `Test email sent to ${dto.to}` };
    } catch (e) {
      throw new BadRequestException(`Gmail rejected the login: ${(e as Error).message}. Use a Google App password (not your normal password).`);
    }
  }

  @Post('test/agora')
  @HttpCode(200)
  async testAgora() {
    const appId = await this.settings.getOrEnv('agora.appId', 'AGORA_APP_ID');
    const certificate = await this.settings.getOrEnv('agora.certificate', 'AGORA_APP_CERTIFICATE');
    if (!appId) throw new BadRequestException('Agora App ID is not set');
    const token = certificate ? RtcTokenBuilder.buildTokenWithUid(appId, certificate, 'test', 1, RtcRole.PUBLISHER, 60, 60) : null;
    return {
      ok: true,
      message: certificate
        ? 'App ID and certificate are set — tokens are being generated. Place a test call from the app to confirm.'
        : 'App ID is set without a certificate (Agora "testing mode"). Add the certificate for production.',
      tokenPreview: token ? `${token.slice(0, 12)}…` : null,
    };
  }

  @Post('test/firebase')
  @HttpCode(200)
  async testFirebase() {
    try {
      await this.push.verify();
      return { ok: true, message: 'Firebase service account works — the server can send push notifications.' };
    } catch (e) {
      throw new BadRequestException(`Firebase: ${(e as Error).message}`);
    }
  }
}

/** Public config the mobile app needs at startup (no secrets). */
@ApiTags('App')
@Controller()
export class AppConfigController {
  constructor(
    private readonly settings: SettingsService,
    private readonly mail: MailService,
  ) {}

  @Public()
  @Get('app-config')
  async config(@Query() q: AppConfigQuery) {
    const [projectId, apiKey, senderId, androidAppId, iosAppId] = await Promise.all([
      this.settings.get('firebase.projectId'),
      this.settings.get('firebase.apiKey'),
      this.settings.get('firebase.messagingSenderId'),
      this.settings.get('firebase.androidAppId'),
      this.settings.get('firebase.iosAppId'),
    ]);
    const appId = q.platform === 'ios' ? iosAppId : androidAppId;
    return {
      emailLogin: await this.mail.configured(),
      firebase: projectId && apiKey && senderId && appId ? { projectId, apiKey, messagingSenderId: senderId, appId } : null,
    };
  }
}

/** Each logged-in app install registers its FCM token here. */
@ApiTags('Devices')
@ApiBearerAuth()
@Controller('devices')
export class DevicesController {
  constructor(private readonly push: PushService) {}

  @Post()
  @HttpCode(200)
  async register(@CurrentUser() u: AuthUser, @Body() dto: DeviceDto) {
    await this.push.registerDevice(u.sub, dto.token, dto.platform);
    return { ok: true };
  }

  @Post('remove')
  @HttpCode(200)
  async remove(@CurrentUser() u: AuthUser, @Body() dto: DeviceDto) {
    await this.push.removeDevice(u.sub, dto.token);
    return { ok: true };
  }
}

@Global()
@Module({
  controllers: [AdminSettingsController, AppConfigController, DevicesController],
  providers: [SettingsService, MailService, PushService],
  exports: [SettingsService, MailService, PushService],
})
export class SettingsModule {}
