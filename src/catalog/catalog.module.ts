import { Body, Controller, Get, Injectable, Module, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { CacheService } from '../cache/cache.service';
import { ADMIN_ROLES, AuthUser, ClientIp, CurrentUser, Public, Roles } from '../common/decorators';
import { slugify } from '../common/utils';
import { PrismaService } from '../prisma/prisma.service';

const NS = 'catalog';
const TTL = 1800;

// ─────────── DTOs ───────────

export class SpecialtyDto {
  @ApiProperty() @IsString() @MaxLength(80) nameEn: string;
  @ApiProperty() @IsString() @MaxLength(80) nameBn: string;
  @ApiPropertyOptional({ description: 'Icon key used by the apps, e.g. "heart", "baby", "brain"' })
  @IsOptional() @IsString() @MaxLength(40) icon?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) description?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(0) sortOrder?: number;
}
export class UpdateSpecialtyDto extends PartialType(SpecialtyDto) {}

export class DesignationDto {
  @ApiProperty() @IsString() @MaxLength(80) nameEn: string;
  @ApiProperty() @IsString() @MaxLength(80) nameBn: string;
  @ApiPropertyOptional({ description: 'Higher = more senior' }) @IsOptional() @Type(() => Number) @IsInt() rank?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}
export class UpdateDesignationDto extends PartialType(DesignationDto) {}

export class HospitalDto {
  @ApiProperty() @IsString() @MaxLength(150) name: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(150) nameBn?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) address?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(30) phone?: string;
  @ApiProperty() @Type(() => Number) @IsInt() divisionId: number;
  @ApiProperty() @Type(() => Number) @IsInt() districtId: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() upazilaId?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}
export class UpdateHospitalDto extends PartialType(HospitalDto) {}

class HospitalQuery {
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() districtId?: number;
}

// ─────────── Service ───────────

@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
  ) {}

  /** Public specialty list with the number of bookable doctors in each. */
  async specialties() {
    return this.cache.wrap(await this.cache.key(NS, 'specialties'), TTL, async () => {
      const rows = await this.prisma.specialty.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { nameEn: 'asc' }],
        select: {
          id: true,
          nameEn: true,
          nameBn: true,
          slug: true,
          icon: true,
          description: true,
          _count: { select: { doctors: { where: { doctor: { status: 'ACTIVE', verificationStatus: 'VERIFIED' } } } } },
        },
      });
      return rows.map(({ _count, ...s }) => ({ ...s, doctorCount: _count.doctors }));
    });
  }

  async designations() {
    return this.cache.wrap(await this.cache.key(NS, 'designations'), TTL, () =>
      this.prisma.designation.findMany({ where: { isActive: true }, orderBy: { rank: 'desc' } }),
    );
  }

  hospitals(districtId?: number) {
    return this.prisma.hospital.findMany({
      where: districtId ? { districtId } : {},
      orderBy: { name: 'asc' },
      include: { district: { select: { nameEn: true, nameBn: true } } },
    });
  }

  adminSpecialties() {
    return this.prisma.specialty.findMany({
      orderBy: [{ sortOrder: 'asc' }, { nameEn: 'asc' }],
      include: { _count: { select: { doctors: true } } },
    });
  }

  adminDesignations() {
    return this.prisma.designation.findMany({ orderBy: { rank: 'desc' }, include: { _count: { select: { doctors: true } } } });
  }

  async createSpecialty(dto: SpecialtyDto, u: AuthUser, ip?: string) {
    const row = await this.prisma.specialty.create({ data: { ...dto, slug: slugify(dto.nameEn) } });
    return this.done('specialty.create', 'specialties', row, u, ip);
  }

  async updateSpecialty(id: number, dto: UpdateSpecialtyDto, u: AuthUser, ip?: string) {
    const before = await this.prisma.specialty.findUniqueOrThrow({ where: { id } });
    const row = await this.prisma.specialty.update({ where: { id }, data: dto });
    return this.done('specialty.update', 'specialties', row, u, ip, before);
  }

  async createDesignation(dto: DesignationDto, u: AuthUser, ip?: string) {
    const row = await this.prisma.designation.create({ data: dto });
    return this.done('designation.create', 'designations', row, u, ip);
  }

  async updateDesignation(id: number, dto: UpdateDesignationDto, u: AuthUser, ip?: string) {
    const row = await this.prisma.designation.update({ where: { id }, data: dto });
    return this.done('designation.update', 'designations', row, u, ip);
  }

  async createHospital(dto: HospitalDto, u: AuthUser, ip?: string) {
    const row = await this.prisma.hospital.create({ data: dto });
    return this.done('hospital.create', 'hospitals', row, u, ip);
  }

  async updateHospital(id: number, dto: UpdateHospitalDto, u: AuthUser, ip?: string) {
    const row = await this.prisma.hospital.update({ where: { id }, data: dto });
    return this.done('hospital.update', 'hospitals', row, u, ip);
  }

  private async done<T extends { id: number }>(action: string, entity: string, row: T, u: AuthUser, ip?: string, before?: unknown) {
    await this.cache.bump(NS, 'doctors');
    await this.audit.log({ actorId: u.sub, action, entity, entityId: row.id, before, after: row, ip });
    return row;
  }
}

// ─────────── Controllers ───────────

@ApiTags('Catalog')
@Controller()
export class CatalogController {
  constructor(private readonly svc: CatalogService) {}

  @Public() @Get('specialties') specialties() { return this.svc.specialties(); }
  @Public() @Get('designations') designations() { return this.svc.designations(); }
}

@ApiTags('Admin · Catalog')
@ApiBearerAuth()
@Roles(...ADMIN_ROLES)
@Controller('admin')
export class AdminCatalogController {
  constructor(private readonly svc: CatalogService) {}

  @Get('specialties') specialties() { return this.svc.adminSpecialties(); }
  @Post('specialties') createSpecialty(@Body() d: SpecialtyDto, @CurrentUser() u: AuthUser, @ClientIp() ip: string) {
    return this.svc.createSpecialty(d, u, ip);
  }
  @Patch('specialties/:id') updateSpecialty(
    @Param('id', ParseIntPipe) id: number, @Body() d: UpdateSpecialtyDto, @CurrentUser() u: AuthUser, @ClientIp() ip: string,
  ) {
    return this.svc.updateSpecialty(id, d, u, ip);
  }

  @Get('designations') designations() { return this.svc.adminDesignations(); }
  @Post('designations') createDesignation(@Body() d: DesignationDto, @CurrentUser() u: AuthUser, @ClientIp() ip: string) {
    return this.svc.createDesignation(d, u, ip);
  }
  @Patch('designations/:id') updateDesignation(
    @Param('id', ParseIntPipe) id: number, @Body() d: UpdateDesignationDto, @CurrentUser() u: AuthUser, @ClientIp() ip: string,
  ) {
    return this.svc.updateDesignation(id, d, u, ip);
  }

  @Get('hospitals') hospitals(@Query() q: HospitalQuery) { return this.svc.hospitals(q.districtId); }
  @Post('hospitals') createHospital(@Body() d: HospitalDto, @CurrentUser() u: AuthUser, @ClientIp() ip: string) {
    return this.svc.createHospital(d, u, ip);
  }
  @Patch('hospitals/:id') updateHospital(
    @Param('id', ParseIntPipe) id: number, @Body() d: UpdateHospitalDto, @CurrentUser() u: AuthUser, @ClientIp() ip: string,
  ) {
    return this.svc.updateHospital(id, d, u, ip);
  }
}

@Module({ controllers: [CatalogController, AdminCatalogController], providers: [CatalogService], exports: [CatalogService] })
export class CatalogModule {}
