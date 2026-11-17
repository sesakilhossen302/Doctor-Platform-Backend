import { randomBytes } from 'crypto';

/*
 * Bangladesh is UTC+6 with no daylight saving, so a fixed offset is exact.
 * Schedule times ("HH:mm") and calendar dates ("YYYY-MM-DD") are always Asia/Dhaka.
 */
export const DHAKA_OFFSET = '+06:00';
const OFFSET_MS = 6 * 60 * 60 * 1000;

/** "2026-11-20" + "17:30" (Dhaka) → UTC Date */
export function dhakaDateTime(date: string, time: string): Date {
  return new Date(`${date}T${time}:00${DHAKA_OFFSET}`);
}

/** Day of week (0 = Sunday) of a Dhaka calendar date. */
export function dhakaDayOfWeek(date: string): number {
  return new Date(`${date}T12:00:00${DHAKA_OFFSET}`).getUTCDay();
}

/** Calendar date in Dhaka (YYYY-MM-DD) for a given instant. */
export function dhakaDate(at = new Date()): string {
  return new Date(at.getTime() + OFFSET_MS).toISOString().slice(0, 10);
}

/** Clock time in Dhaka (HH:mm) for a given instant. */
export function dhakaTime(at: Date): string {
  return new Date(at.getTime() + OFFSET_MS).toISOString().slice(11, 16);
}

/** YYYY-MM-DD as a UTC-midnight Date — for @db.Date columns. */
export function dateOnly(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

export function addDays(date: string, days: number): string {
  const d = dateOnly(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function fromMinutes(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

export function isValidDate(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(new Date(`${date}T00:00:00Z`).getTime());
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/^dr\.?\s+/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 60);
}

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
/** Short human-friendly code without ambiguous characters (0/O, 1/I), e.g. "DA-7K3P9Q". */
export function shortCode(prefix: string, length = 6): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return `${prefix}-${out}`;
}

/** Normalises Bangladeshi mobile numbers to 01XXXXXXXXX, or returns null if invalid. */
export function normalizeBdPhone(input: string): string | null {
  const digits = input.replace(/[^\d]/g, '');
  const local = digits.startsWith('880') ? `0${digits.slice(3)}` : digits;
  return /^01[3-9]\d{8}$/.test(local) ? local : null;
}
