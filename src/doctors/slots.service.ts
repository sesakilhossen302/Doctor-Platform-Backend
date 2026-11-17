import { BadRequestException, Injectable } from '@nestjs/common';
import { ConsultationType, SlotStatus } from '@prisma/client';
import {
  addDays,
  dateOnly,
  dhakaDate,
  dhakaDateTime,
  dhakaDayOfWeek,
  fromMinutes,
  isValidDate,
  toMinutes,
} from '../common/utils';
import { PrismaService } from '../prisma/prisma.service';

export const BOOKING_WINDOW_DAYS = 30;
/** Patients cannot book a slot that starts in less than this many minutes. */
const MIN_LEAD_MINUTES = 10;

export interface SlotView {
  startAt: string;
  endAt: string;
  time: string;
  endTime: string;
  type: ConsultationType;
  chamberId: string | null;
  chamberName: string | null;
  available: boolean;
}

export interface DaySlots {
  date: string;
  onLeave: boolean;
  slots: SlotView[];
}

/** Online audio and video share the same online schedule; chamber has its own. */
export function scheduleTypesFor(type: ConsultationType): ConsultationType[] {
  return type === ConsultationType.CHAMBER
    ? [ConsultationType.CHAMBER]
    : [ConsultationType.ONLINE_AUDIO, ConsultationType.ONLINE_VIDEO];
}

/**
 * Slots are generated on the fly from weekly schedules (no pre-generated rows),
 * minus leave days, past times and slots already booked / blocked / held.
 * Any date range is computed with exactly 3 queries.
 */
@Injectable()
export class SlotsService {
  constructor(private readonly prisma: PrismaService) {}

  async forDate(doctorId: string, date: string, type?: ConsultationType): Promise<DaySlots> {
    if (!isValidDate(date)) throw new BadRequestException('date must be YYYY-MM-DD');
    const [day] = await this.compute(doctorId, [date], type);
    return day;
  }

  /** Upcoming dates (default 14) that still have at least one free slot. */
  async availableDates(doctorId: string, type?: ConsultationType, days = 14) {
    const today = dhakaDate();
    const dates = Array.from({ length: days }, (_, i) => addDays(today, i));
    const result = await this.compute(doctorId, dates, type);
    return result
      .map((d) => ({ date: d.date, freeSlots: d.slots.filter((s) => s.available).length }))
      .filter((d) => d.freeSlots > 0);
  }

  /** Returns the slot if `startAt` is a real, currently-free slot for this doctor; throws otherwise. */
  async resolve(doctorId: string, startAtIso: string, type: ConsultationType): Promise<SlotView> {
    const startAt = new Date(startAtIso);
    if (Number.isNaN(startAt.getTime())) throw new BadRequestException('Invalid slot time');
    const { slots, onLeave } = await this.forDate(doctorId, dhakaDate(startAt), type);
    if (onLeave) throw new BadRequestException('The doctor is on leave that day');
    const slot = slots.find((s) => s.startAt === startAt.toISOString());
    if (!slot) throw new BadRequestException('This time is not in the doctor’s schedule');
    if (!slot.available) throw new BadRequestException('This slot is no longer available. Please choose another time');
    return slot;
  }

  private async compute(doctorId: string, dates: string[], type?: ConsultationType): Promise<DaySlots[]> {
    const today = dhakaDate();
    const lastDay = addDays(today, BOOKING_WINDOW_DAYS);
    const inWindow = dates.filter((d) => d >= today && d <= lastDay).sort();
    if (!inWindow.length) return dates.map((date) => ({ date, onLeave: false, slots: [] }));

    const now = new Date();
    const rangeStart = dhakaDateTime(inWindow[0], '00:00');
    const rangeEnd = new Date(dhakaDateTime(inWindow[inWindow.length - 1], '00:00').getTime() + 86_400_000);
    const weekdays = [...new Set(inWindow.map(dhakaDayOfWeek))];

    const [schedules, leaves, taken] = await Promise.all([
      this.prisma.doctorSchedule.findMany({
        where: {
          doctorId,
          isActive: true,
          dayOfWeek: { in: weekdays },
          ...(type ? { type: { in: scheduleTypesFor(type) } } : {}),
        },
        include: { chamber: { select: { name: true, isActive: true } } },
        orderBy: { startTime: 'asc' },
      }),
      this.prisma.doctorLeave.findMany({
        where: { doctorId, date: { gte: dateOnly(inWindow[0]), lte: dateOnly(inWindow[inWindow.length - 1]) } },
        select: { date: true },
      }),
      this.prisma.appointmentSlot.findMany({
        where: {
          doctorId,
          startAt: { gte: rangeStart, lt: rangeEnd },
          OR: [
            { status: { in: [SlotStatus.BOOKED, SlotStatus.BLOCKED] } },
            { status: SlotStatus.HELD, holdExpiresAt: { gt: now } },
          ],
        },
        select: { startAt: true },
      }),
    ]);

    const leaveSet = new Set(leaves.map((l) => l.date.toISOString().slice(0, 10)));
    const takenSet = new Set(taken.map((t) => t.startAt.getTime()));
    const earliest = now.getTime() + MIN_LEAD_MINUTES * 60_000;

    return dates.map((date) => {
      if (date < today || date > lastDay) return { date, onLeave: false, slots: [] };
      if (leaveSet.has(date)) return { date, onLeave: true, slots: [] };

      const dow = dhakaDayOfWeek(date);
      const seen = new Set<number>();
      const slots: SlotView[] = [];
      for (const s of schedules) {
        if (s.dayOfWeek !== dow || (s.chamber && !s.chamber.isActive)) continue;
        const end = toMinutes(s.endTime);
        for (let m = toMinutes(s.startTime); m + s.slotMinutes <= end; m += s.slotMinutes) {
          const time = fromMinutes(m);
          const endTime = fromMinutes(m + s.slotMinutes);
          const startAt = dhakaDateTime(date, time);
          const ts = startAt.getTime();
          if (seen.has(ts)) continue; // overlapping schedules — first one wins
          seen.add(ts);
          slots.push({
            startAt: startAt.toISOString(),
            endAt: dhakaDateTime(date, endTime).toISOString(),
            time,
            endTime,
            type: s.type,
            chamberId: s.chamberId,
            chamberName: s.chamber?.name ?? null,
            available: ts >= earliest && !takenSet.has(ts),
          });
        }
      }
      slots.sort((a, b) => a.startAt.localeCompare(b.startAt));
      return { date, onLeave: false, slots };
    });
  }
}
