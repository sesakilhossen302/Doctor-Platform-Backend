import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { App, cert, deleteApp, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from './settings.service';

export interface PushMessage {
  title: string;
  body: string;
  /** String key/values delivered to the app (e.g. { type: 'call', consultationId }). */
  data?: Record<string, string>;
  /** Android notification channel: 'calls' rings louder; 'general' for everything else. */
  channel?: 'calls' | 'general';
}

/**
 * Firebase Cloud Messaging. The service-account JSON is pasted in Admin → Settings → Integrations.
 * Push is best-effort: a failure never breaks the request that triggered it.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private current?: { fingerprint: string; app: App };

  constructor(
    private readonly settings: SettingsService,
    private readonly prisma: PrismaService,
  ) {}

  private async app(): Promise<App | null> {
    const json = await this.settings.get('firebase.serviceAccount');
    if (!json) return null;
    const fingerprint = createHash('sha256').update(json).digest('hex').slice(0, 16);
    if (this.current?.fingerprint === fingerprint) return this.current.app;
    const old = this.current;
    const app = initializeApp({ credential: cert(JSON.parse(json)) }, `fcm-${fingerprint}`);
    this.current = { fingerprint, app };
    if (old) await deleteApp(old.app).catch(() => undefined);
    return app;
  }

  async configured() {
    return !!(await this.settings.get('firebase.serviceAccount'));
  }

  /** Confirms the service account can obtain a Google access token. */
  async verify() {
    const app = await this.app();
    if (!app) throw new ServiceUnavailableException('Firebase service account is not set');
    await app.options.credential!.getAccessToken();
  }

  async registerDevice(userId: string, token: string, platform: string) {
    await this.prisma.deviceToken.upsert({
      where: { token },
      create: { userId, token, platform },
      update: { userId, platform, lastSeenAt: new Date() },
    });
  }

  async removeDevice(userId: string, token: string) {
    await this.prisma.deviceToken.deleteMany({ where: { token, userId } });
  }

  async sendToUser(userId: string | null | undefined, msg: PushMessage) {
    if (!userId) return { sent: 0 };
    try {
      const app = await this.app();
      if (!app) return { sent: 0 };
      const devices = await this.prisma.deviceToken.findMany({ where: { userId }, select: { token: true } });
      if (!devices.length) return { sent: 0 };
      const tokens = devices.map((d) => d.token);
      const res = await getMessaging(app).sendEachForMulticast({
        tokens,
        notification: { title: msg.title, body: msg.body },
        data: msg.data,
        android: {
          priority: 'high',
          ttl: msg.channel === 'calls' ? 45_000 : 24 * 3600_000,
          notification: { channelId: msg.channel ?? 'general', sound: 'default', priority: msg.channel === 'calls' ? 'max' : 'high' },
        },
        apns: { headers: { 'apns-priority': '10' }, payload: { aps: { sound: 'default' } } },
      });
      // Forget tokens of uninstalled apps.
      const dead = res.responses
        .map((r, i) => (!r.success && /registration-token-not-registered|invalid-registration-token|invalid-argument/.test(r.error?.code ?? '') ? tokens[i] : null))
        .filter((t): t is string => !!t);
      if (dead.length) await this.prisma.deviceToken.deleteMany({ where: { token: { in: dead } } });
      return { sent: res.successCount };
    } catch (e) {
      this.logger.warn(`push failed: ${(e as Error).message}`);
      return { sent: 0 };
    }
  }
}
