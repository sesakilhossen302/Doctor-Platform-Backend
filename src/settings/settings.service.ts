import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { AuditService } from '../audit/audit.service';
import { CacheService } from '../cache/cache.service';
import { PrismaService } from '../prisma/prisma.service';

/** Every setting the admin can manage. `secret` values are encrypted at rest and never sent back. */
export const SETTING_KEYS = {
  'agora.appId': { secret: false },
  'agora.certificate': { secret: true },
  'mail.gmailUser': { secret: false },
  'mail.appPassword': { secret: true },
  'mail.fromName': { secret: false },
  'firebase.projectId': { secret: false },
  'firebase.apiKey': { secret: false },
  'firebase.messagingSenderId': { secret: false },
  'firebase.androidAppId': { secret: false },
  'firebase.iosAppId': { secret: false },
  'firebase.serviceAccount': { secret: true },
} as const;

export type SettingKey = keyof typeof SETTING_KEYS;

const CACHE_KEY = 'settings:all';

/**
 * Integration settings stored in the database so admins can change them without editing
 * server files. Environment variables remain a fallback (e.g. AGORA_APP_ID).
 */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);
  private readonly key: Buffer;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {
    // A dedicated key is recommended; otherwise derive one from the JWT secret.
    // Changing either makes previously saved secrets unreadable (re-enter them in the dashboard).
    const material = config.get<string>('SETTINGS_ENCRYPTION_KEY') || config.get<string>('JWT_ACCESS_SECRET') || '';
    this.key = createHash('sha256').update(`settings:${material}`).digest();
  }

  private encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${data.toString('base64')}`;
  }

  private decrypt(stored: string): string | undefined {
    try {
      const [, iv, tag, data] = stored.split(':');
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      this.logger.error('Could not decrypt a saved secret — was SETTINGS_ENCRYPTION_KEY/JWT_ACCESS_SECRET changed? Re-enter it in the dashboard.');
      return undefined;
    }
  }

  /** All settings, decrypted, cached briefly (shared via Redis when configured). */
  private async all(): Promise<Partial<Record<SettingKey, string>>> {
    return this.cache.wrap(CACHE_KEY, 30, async () => {
      const rows = await this.prisma.appSetting.findMany();
      const out: Partial<Record<SettingKey, string>> = {};
      for (const r of rows) {
        const v = r.isSecret ? this.decrypt(r.value) : r.value;
        if (v !== undefined) out[r.key as SettingKey] = v;
      }
      return out;
    });
  }

  async get(key: SettingKey): Promise<string | undefined> {
    const v = (await this.all())[key];
    return v && v.length ? v : undefined;
  }

  /** Setting from the dashboard, else the given environment variable. */
  async getOrEnv(key: SettingKey, envName: string): Promise<string | undefined> {
    return (await this.get(key)) ?? (this.config.get<string>(envName) || undefined);
  }

  /**
   * Save values. `undefined` = leave unchanged, `''` = clear.
   * Secrets are encrypted; the audit log records which keys changed, never the values.
   */
  async save(values: Partial<Record<SettingKey, string | undefined>>, actorId: string, ip?: string) {
    const changed: string[] = [];
    for (const [k, v] of Object.entries(values) as [SettingKey, string | undefined][]) {
      if (v === undefined || !(k in SETTING_KEYS)) continue;
      const value = v.trim();
      changed.push(k);
      if (!value) {
        await this.prisma.appSetting.deleteMany({ where: { key: k } });
        continue;
      }
      const secret = SETTING_KEYS[k].secret;
      const stored = secret ? this.encrypt(value) : value;
      await this.prisma.appSetting.upsert({
        where: { key: k },
        create: { key: k, value: stored, isSecret: secret, updatedById: actorId },
        update: { value: stored, isSecret: secret, updatedById: actorId },
      });
    }
    await this.cache.del(CACHE_KEY);
    if (changed.length) await this.audit.log({ actorId, action: 'settings.update', entity: 'app_settings', after: { keys: changed }, ip });
    return changed;
  }

  /** Masked view for the dashboard: plain values as-is, secrets only as "set / not set". */
  async masked() {
    const all = await this.all();
    const rows = await this.prisma.appSetting.findMany({ select: { key: true, updatedAt: true } });
    const updated = Object.fromEntries(rows.map((r) => [r.key, r.updatedAt]));
    const out: Record<string, { value?: string; isSet: boolean; secret: boolean; updatedAt?: Date }> = {};
    for (const [k, meta] of Object.entries(SETTING_KEYS)) {
      const v = all[k as SettingKey];
      out[k] = { secret: meta.secret, isSet: !!v, updatedAt: updated[k], ...(meta.secret ? {} : { value: v ?? '' }) };
    }
    return out;
  }
}
