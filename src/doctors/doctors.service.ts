import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConsultationType, DoctorStatus, Prisma, Role, VerificationStatus } from '@prisma/client';
import { randomBytes } from 'crypto';
import { AuditService } from '../audit/audit.service';
import { CacheService } from '../cache/cache.service';
import { AuthUser } from '../common/decorators';
import { paginate } from '../common/pagination';
import { dateOnly, normalizeBdPhone, slugify, toMinutes } from '../common/utils';
import { PrismaService } from '../prisma/prisma.service';
import {
  AdminDoctorQueryDto,
  ChamberDto,
  DoctorDto,
  DoctorQueryDto,
  DoctorVerificationDto,
  LeaveDto,
  ReplaceSchedulesDto,
  UpdateChamberDto,
  UpdateDoctorDto,
} from './doctors.dto';

const NS = 'doctors';
const LIST_TTL = 60;
const DETAIL_TTL = 120;

/** Only these doctors are ever visible to patients. */
const PUBLIC_WHERE: Prisma.DoctorWhereInput = {
  status: DoctorStatus.ACTIVE,
  verificationStatus: VerificationStatus.VERIFIED,
};

/** Fields for a doctor card — kept small so list responses stay fast. */
const CARD_SELECT = {
  id: true,
  slug: true,
  nameEn: true,
  nameBn: true,
  gender: true,
  photoUrl: true,
  degrees: true,
  experienceYears: true,
  onlineFee: true,
  chamberFee: true,
  ratingAvg: true,
  ratingCount: true,
  consultationTypes: true,
  isAvailableNow: true,
  isDemo: true,
  verificationStatus: true,
  designation: { select: { nameEn: true, nameBn: true } },
  specialties: {
    orderBy: { isPrimary: 'desc' },
    take: 3,
    select: { isPrimary: true, specialty: { select: { id: true, nameEn: true, nameBn: true, slug: true } } },
  },
  chambers: {
    where: { isActive: true },
    take: 1,
    select: {
      name: true,
      hospital: { select: { name: true, nameBn: true } },
      district: { select: { nameEn: true, nameBn: true } },
    },
  },
} satisfies Prisma.DoctorSelect;

@Injectable()
export class DoctorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
  ) {}

  // ─────────────────────────── Public ───────────────────────────

  async list(q: DoctorQueryDto) {
    const keyPayload = JSON.stringify(Object.entries(q).filter(([, v]) => v !== undefined).sort());
    const key = await this.cache.key(NS, `list:${keyPayload}`);
    return this.cache.wrap(key, LIST_TTL, async () => {
      const where = this.publicWhere(q);
      const [items, total] = await this.prisma.$transaction([
        this.prisma.doctor.findMany({
          where,
          select: CARD_SELECT,
          orderBy: this.orderBy(q),
          skip: (q.page - 1) * q.limit,
          take: q.limit,
        }),
        this.prisma.doctor.count({ where }),
      ]);
      return paginate(items, total, q.page, q.limit);
    });
  }

  async detail(idOrSlug: string) {
    const key = await this.cache.key(NS, `detail:${idOrSlug}`);
    const doctor = await this.cache.wrap(key, DETAIL_TTL, () =>
      this.prisma.doctor.findFirst({
        where: { ...PUBLIC_WHERE, ...(isUuid(idOrSlug) ? { id: idOrSlug } : { slug: idOrSlug }) },
        select: {
          ...CARD_SELECT,
          bio: true,
          languages: true,
          bmdcNumber: true,
          verifiedAt: true,
          specialties: {
            orderBy: { isPrimary: 'desc' },
            select: { isPrimary: true, specialty: { select: { id: true, nameEn: true, nameBn: true, slug: true } } },
          },
          chambers: {
            where: { isActive: true },
            select: {
              id: true,
              name: true,
              address: true,
              hospital: { select: { id: true, name: true, nameBn: true } },
              district: { select: { id: true, nameEn: true, nameBn: true } },
              upazila: { select: { id: true, nameEn: true, nameBn: true } },
            },
          },
          schedules: {
            where: { isActive: true },
            orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
            select: { type: true, dayOfWeek: true, startTime: true, endTime: true, slotMinutes: true, chamberId: true },
          },
        },
      }),
    );
    if (!doctor) throw new NotFoundException('Doctor not found');
    return doctor;
  }

  /** Doctor id from id/slug, only if publicly bookable. */
  async publicIdOrThrow(idOrSlug: string): Promise<string> {
    return (await this.detail(idOrSlug)).id;
  }

  private publicWhere(q: DoctorQueryDto): Prisma.DoctorWhereInput {
    const and: Prisma.DoctorWhereInput[] = [PUBLIC_WHERE];
    if (q.specialtyId) and.push({ specialties: { some: { specialtyId: q.specialtyId } } });
    if (q.divisionId || q.districtId || q.upazilaId || q.hospitalId) {
      and.push({
        chambers: {
          some: {
            isActive: true,
            ...(q.divisionId && { divisionId: q.divisionId }),
            ...(q.districtId && { districtId: q.districtId }),
            ...(q.upazilaId && { upazilaId: q.upazilaId }),
            ...(q.hospitalId && { hospitalId: q.hospitalId }),
          },
        },
      });
    }
    if (q.type) and.push({ consultationTypes: { has: q.type } });
    if (q.minExperience) and.push({ experienceYears: { gte: q.minExperience } });
    if (q.availableNow) and.push({ isAvailableNow: true });
    if (q.maxFee !== undefined) {
      if (q.type === ConsultationType.CHAMBER) and.push({ chamberFee: { lte: q.maxFee } });
      else if (q.type) and.push({ onlineFee: { lte: q.maxFee } });
      else and.push({ OR: [{ chamberFee: { lte: q.maxFee } }, { onlineFee: { lte: q.maxFee } }] });
    }
    const text = q.q?.trim();
    if (text) {
      and.push({
        OR: [
          { nameEn: { contains: text, mode: 'insensitive' } },
          { nameBn: { contains: text } },
          { degrees: { contains: text, mode: 'insensitive' } },
          { specialties: { some: { specialty: { OR: [{ nameEn: { contains: text, mode: 'insensitive' } }, { nameBn: { contains: text } }] } } } },
        ],
      });
    }
    return { AND: and };
  }

  private orderBy(q: DoctorQueryDto): Prisma.DoctorOrderByWithRelationInput[] {
    const feeField = q.type && q.type !== ConsultationType.CHAMBER ? 'onlineFee' : 'chamberFee';
    switch (q.sort) {
      case 'fee_asc':
        return [{ [feeField]: 'asc' }, { id: 'asc' }];
      case 'fee_desc':
        return [{ [feeField]: 'desc' }, { id: 'asc' }];
      case 'experience':
        return [{ experienceYears: 'desc' }, { id: 'asc' }];
      default:
        return [{ ratingAvg: 'desc' }, { ratingCount: 'desc' }, { id: 'asc' }];
    }
  }

  // ─────────────────────────── Admin ───────────────────────────

  async adminList(q: AdminDoctorQueryDto) {
    const where: Prisma.DoctorWhereInput = {
      ...(q.status ? { status: q.status } : { status: { not: DoctorStatus.ARCHIVED } }),
      ...(q.verificationStatus && { verificationStatus: q.verificationStatus }),
      ...(q.specialtyId && { specialties: { some: { specialtyId: q.specialtyId } } }),
      ...(q.districtId && { chambers: { some: { districtId: q.districtId } } }),
      ...(q.q?.trim() && {
        OR: [
          { nameEn: { contains: q.q.trim(), mode: 'insensitive' } },
          { nameBn: { contains: q.q.trim() } },
          { bmdcNumber: { contains: q.q.trim(), mode: 'insensitive' } },
        ],
      }),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.doctor.findMany({
        where,
        select: { ...CARD_SELECT, status: true, bmdcNumber: true, createdAt: true, _count: { select: { appointments: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
      this.prisma.doctor.count({ where }),
    ]);
    return paginate(items, total, q.page, q.limit);
  }

  async adminGet(id: string) {
    const doctor = await this.prisma.doctor.findUnique({
      where: { id },
      include: {
        designation: true,
        user: { select: { phone: true, email: true, lastLoginAt: true } },
        specialties: { include: { specialty: true }, orderBy: { isPrimary: 'desc' } },
        credentials: { orderBy: { createdAt: 'desc' } },
        chambers: { include: { hospital: true, district: true, division: true, upazila: true }, orderBy: { createdAt: 'asc' } },
        schedules: { orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }] },
        leaves: { where: { date: { gte: dateOnly(new Date().toISOString().slice(0, 10)) } }, orderBy: { date: 'asc' } },
        _count: { select: { appointments: true } },
      },
    });
    if (!doctor) throw new NotFoundException('Doctor not found');
    return doctor;
  }

  async create(dto: DoctorDto, u: AuthUser, ip?: string) {
    const { specialtyIds, ...data } = dto;
    const doctor = await this.prisma.doctor.create({
      data: {
        ...data,
        bmdcNumber: data.bmdcNumber?.trim() || undefined,
        slug: `${slugify(dto.nameEn)}-${randomBytes(2).toString('hex')}`,
        specialties: specialtyIds?.length
          ? { create: specialtyIds.map((specialtyId, i) => ({ specialtyId, isPrimary: i === 0 })) }
          : undefined,
      },
    });
    await this.changed('doctor.create', doctor.id, u, ip, undefined, doctor);
    return this.adminGet(doctor.id);
  }

  async update(id: string, dto: UpdateDoctorDto, u: AuthUser, ip?: string) {
    const before = await this.adminGet(id);
    const { specialtyIds, ...data } = dto;
    await this.prisma.$transaction(async (tx) => {
      await tx.doctor.update({ where: { id }, data: { ...data, bmdcNumber: data.bmdcNumber?.trim() || undefined } });
      if (specialtyIds) {
        await tx.doctorSpecialty.deleteMany({ where: { doctorId: id } });
        if (specialtyIds.length) {
          await tx.doctorSpecialty.createMany({
            data: specialtyIds.map((specialtyId, i) => ({ doctorId: id, specialtyId, isPrimary: i === 0 })),
          });
        }
      }
    });
    const after = await this.adminGet(id);
    await this.changed('doctor.update', id, u, ip, pickAudit(before), pickAudit(after));
    return after;
  }

  async setStatus(id: string, status: DoctorStatus, u: AuthUser, ip?: string) {
    const before = await this.prisma.doctor.findUniqueOrThrow({ where: { id }, select: { status: true } });
    const doc = await this.prisma.doctor.update({ where: { id }, data: { status, ...(status !== DoctorStatus.ACTIVE && { isAvailableNow: false }) } });
    await this.changed('doctor.status', id, u, ip, before, { status: doc.status });
    return doc;
  }

  async setVerification(id: string, dto: DoctorVerificationDto, u: AuthUser, ip?: string) {
    const before = await this.prisma.doctor.findUniqueOrThrow({ where: { id }, select: { verificationStatus: true } });
    const verified = dto.verificationStatus === VerificationStatus.VERIFIED;
    const doc = await this.prisma.doctor.update({
      where: { id },
      data: {
        verificationStatus: dto.verificationStatus,
        verifiedAt: verified ? new Date() : null,
        verifiedById: verified ? u.sub : null,
      },
    });
    await this.changed('doctor.verification', id, u, ip, before, { verificationStatus: doc.verificationStatus, notes: dto.notes });
    return doc;
  }

  async setAvailableNow(id: string, isAvailableNow: boolean, u: AuthUser, ip?: string) {
    const doc = await this.prisma.doctor.update({ where: { id }, data: { isAvailableNow } });
    await this.changed('doctor.availability', id, u, ip, undefined, { isAvailableNow });
    return doc;
  }

  /**
   * Gives the doctor a login for the doctor app (OTP on this phone number).
   * The phone must not belong to a patient or another doctor.
   */
  async linkAppLogin(id: string, input: { phone?: string; email?: string }, u: AuthUser, ip?: string) {
    const phone = input.phone ? normalizeBdPhone(input.phone) : null;
    if (input.phone && !phone) throw new BadRequestException('Enter a valid Bangladeshi mobile number');
    const email = input.email?.trim().toLowerCase() || null;
    if (!phone && !email) throw new BadRequestException('Enter a mobile number or an email');
    const doctor = await this.prisma.doctor.findUniqueOrThrow({ where: { id }, select: { id: true, nameEn: true, userId: true } });

    // Every identifier must be free or already belong to this doctor's login.
    const owners = await this.prisma.user.findMany({
      where: { OR: [...(phone ? [{ phone }] : []), ...(email ? [{ email }] : [])] },
      include: { doctor: { select: { id: true } } },
    });
    for (const o of owners) {
      if (o.role !== Role.DOCTOR) throw new BadRequestException('This number/email is already registered as a patient or staff account');
      if (o.doctor && o.doctor.id !== id) throw new BadRequestException('This number/email is already linked to another doctor');
    }
    if (owners.length > 1) throw new BadRequestException('The number and email belong to two different accounts');

    const target = owners[0] ?? (doctor.userId ? await this.prisma.user.findUnique({ where: { id: doctor.userId } }) : null);
    let userId: string;
    if (target) {
      userId = (await this.prisma.user.update({ where: { id: target.id }, data: { ...(phone && { phone }), ...(email && { email }) } })).id;
    } else {
      userId = (await this.prisma.user.create({ data: { phone, email, name: doctor.nameEn, role: Role.DOCTOR } })).id;
    }
    // Detach the previous login (it can no longer act as this doctor).
    if (doctor.userId && doctor.userId !== userId) {
      await this.prisma.refreshToken.updateMany({ where: { userId: doctor.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    await this.prisma.doctor.update({ where: { id }, data: { userId } });
    await this.changed('doctor.app_login', id, u, ip, { userId: doctor.userId }, { phone, email });
    return { phone, email, userId };
  }

  // Chambers
  async addChamber(doctorId: string, dto: ChamberDto, u: AuthUser, ip?: string) {
    await this.assertDistrictInDivision(dto.districtId, dto.divisionId);
    const chamber = await this.prisma.chamber.create({ data: { ...dto, doctorId } });
    await this.changed('chamber.create', doctorId, u, ip, undefined, chamber);
    return chamber;
  }

  async updateChamber(doctorId: string, chamberId: string, dto: UpdateChamberDto, u: AuthUser, ip?: string) {
    const before = await this.prisma.chamber.findFirst({ where: { id: chamberId, doctorId } });
    if (!before) throw new NotFoundException('Chamber not found');
    if (dto.districtId || dto.divisionId) {
      await this.assertDistrictInDivision(dto.districtId ?? before.districtId, dto.divisionId ?? before.divisionId);
    }
    const chamber = await this.prisma.chamber.update({ where: { id: chamberId }, data: dto });
    await this.changed('chamber.update', doctorId, u, ip, before, chamber);
    return chamber;
  }

  // Schedules
  async replaceSchedules(doctorId: string, dto: ReplaceSchedulesDto, u: AuthUser, ip?: string) {
    const chambers = await this.prisma.chamber.findMany({ where: { doctorId }, select: { id: true } });
    const chamberIds = new Set(chambers.map((c) => c.id));

    // Validate: valid ranges, chamber ownership, and no overlapping blocks on the same weekday.
    const byDay = new Map<number, [number, number][]>();
    for (const s of dto.schedules) {
      const start = toMinutes(s.startTime);
      const end = toMinutes(s.endTime);
      if (end - start < s.slotMinutes) throw new BadRequestException(`${s.startTime}-${s.endTime} is shorter than one slot`);
      if (s.type === ConsultationType.CHAMBER && (!s.chamberId || !chamberIds.has(s.chamberId))) {
        throw new BadRequestException('Chamber schedules need a chamber that belongs to this doctor');
      }
      const ranges = byDay.get(s.dayOfWeek) ?? [];
      if (ranges.some(([a, b]) => start < b && a < end)) {
        throw new BadRequestException(`Overlapping schedule on day ${s.dayOfWeek} at ${s.startTime}`);
      }
      ranges.push([start, end]);
      byDay.set(s.dayOfWeek, ranges);
    }

    const before = await this.prisma.doctorSchedule.findMany({ where: { doctorId } });
    await this.prisma.$transaction([
      this.prisma.doctorSchedule.deleteMany({ where: { doctorId } }),
      this.prisma.doctorSchedule.createMany({
        data: dto.schedules.map((s) => ({
          doctorId,
          type: s.type,
          chamberId: s.type === ConsultationType.CHAMBER ? s.chamberId : null,
          dayOfWeek: s.dayOfWeek,
          startTime: s.startTime,
          endTime: s.endTime,
          slotMinutes: s.slotMinutes,
        })),
      }),
    ]);
    const after = await this.prisma.doctorSchedule.findMany({ where: { doctorId }, orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }] });
    await this.changed('schedule.replace', doctorId, u, ip, before, after);
    return after;
  }

  async addLeave(doctorId: string, dto: LeaveDto, u: AuthUser, ip?: string) {
    const leave = await this.prisma.doctorLeave.upsert({
      where: { doctorId_date: { doctorId, date: dateOnly(dto.date) } },
      create: { doctorId, date: dateOnly(dto.date), reason: dto.reason },
      update: { reason: dto.reason },
    });
    await this.changed('leave.create', doctorId, u, ip, undefined, leave);
    return leave;
  }

  async removeLeave(doctorId: string, leaveId: string, u: AuthUser, ip?: string) {
    const { count } = await this.prisma.doctorLeave.deleteMany({ where: { id: leaveId, doctorId } });
    if (!count) throw new NotFoundException('Leave not found');
    await this.changed('leave.delete', doctorId, u, ip, { leaveId });
    return { success: true };
  }

  private async assertDistrictInDivision(districtId: number, divisionId: number) {
    const d = await this.prisma.district.findUnique({ where: { id: districtId }, select: { divisionId: true } });
    if (!d || d.divisionId !== divisionId) throw new BadRequestException('District does not belong to the selected division');
  }

  private async changed(action: string, doctorId: string, u: AuthUser, ip?: string, before?: unknown, after?: unknown) {
    await this.cache.bump(NS, 'catalog');
    await this.audit.log({ actorId: u.sub, action, entity: 'doctors', entityId: doctorId, before, after, ip });
  }
}

function isUuid(v: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

/** Only the fields worth keeping in the audit trail. */
function pickAudit(d: { onlineFee: number; chamberFee: number; status: DoctorStatus; nameEn: string; designationId: number | null; specialties: { specialtyId: number }[] }) {
  return {
    nameEn: d.nameEn,
    onlineFee: d.onlineFee,
    chamberFee: d.chamberFee,
    status: d.status,
    designationId: d.designationId,
    specialtyIds: d.specialties.map((s) => s.specialtyId),
  };
}
