import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'crypto';
import * as nodemailer from 'nodemailer';
import { SettingsService } from './settings.service';

/**
 * Sends email through the Gmail account configured in the admin dashboard
 * (Gmail address + Google "App password"; normal Gmail passwords do not work over SMTP).
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transport?: { fingerprint: string; t: nodemailer.Transporter };

  constructor(private readonly settings: SettingsService) {}

  private async creds() {
    const user = await this.settings.getOrEnv('mail.gmailUser', 'MAIL_GMAIL_USER');
    const pass = await this.settings.getOrEnv('mail.appPassword', 'MAIL_GMAIL_APP_PASSWORD');
    const fromName = (await this.settings.get('mail.fromName')) ?? 'ডাক্তার দেখান';
    return user && pass ? { user, pass: pass.replace(/\s+/g, ''), fromName } : null;
  }

  async configured() {
    return !!(await this.creds());
  }

  private async transporter() {
    const c = await this.creds();
    if (!c) throw new ServiceUnavailableException('Email is not configured: add the Gmail address and App password in Admin → Settings → Integrations');
    const fingerprint = createHash('sha256').update(`${c.user}:${c.pass}`).digest('hex');
    if (this.transport?.fingerprint !== fingerprint) {
      this.transport = {
        fingerprint,
        t: nodemailer.createTransport({ service: 'gmail', auth: { user: c.user, pass: c.pass }, pool: true, maxConnections: 3 }),
      };
    }
    return { t: this.transport.t, from: `"${c.fromName}" <${c.user}>` };
  }

  async send(to: string, subject: string, html: string, text: string) {
    const { t, from } = await this.transporter();
    await t.sendMail({ from, to, subject, html, text });
  }

  async sendOtp(to: string, code: string) {
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:420px;margin:auto;padding:24px;border:1px solid #e3e8ee;border-radius:16px">
        <h2 style="color:#0d8478;margin:0 0 8px">ডাক্তার দেখান</h2>
        <p style="color:#334155">আপনার লগইন কোড:</p>
        <p style="font-size:32px;letter-spacing:8px;font-weight:bold;color:#0f1b2a;margin:8px 0">${code}</p>
        <p style="color:#64748b;font-size:13px">কোডটি ৫ মিনিট পর্যন্ত বৈধ। কাউকে এই কোড বলবেন না।<br/>Your login code is valid for 5 minutes. Never share it.</p>
      </div>`;
    await this.send(to, `আপনার লগইন কোড ${code}`, html, `আপনার লগইন কোড: ${code} (৫ মিনিট বৈধ)। Your login code: ${code}`);
    this.logger.log(`OTP email sent to ${to.replace(/(.{2}).*(@.*)/, '$1***$2')}`);
  }

  /** Throws with Gmail's own message if the credentials are wrong. */
  async verify() {
    const { t } = await this.transporter();
    await t.verify();
  }
}
