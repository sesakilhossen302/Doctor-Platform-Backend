import { BadRequestException, Body, Controller, Get, Injectable, Module, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { CacheService } from '../cache/cache.service';
import { ADMIN_ROLES, AuthUser, ClientIp, CurrentUser, Public, Roles } from '../common/decorators';
import { slugify } from '../common/utils';
import { PrismaService } from '../prisma/prisma.service';

const NS = 'locations';
const TTL = 3600; // location master data changes rarely

const LEVELS = ['divisions', 'districts', 'upazilas'] as const;
type Level = (typeof LEVELS)[number];

export class LocationDto {
  @ApiProperty() @IsString() @MaxLength(80) nameEn: string;
  @ApiProperty() @IsString() @MaxLength(80) nameBn: string;
  @ApiPropertyOptional({ description: 'divisionId for a district, districtId for an upazila' })
  @IsOptional() @Type(() => Number) @IsInt() parentId?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isCity?: boolean;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(0) sortOrder?: number;
}

export class UpdateLocationDto extends PartialType(LocationDto) {}

class LevelQuery {
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() parentId?: number;
}

const orderBy = [{ sortOrder: 'asc' as const }, { nameEn: 'asc' as const }];
const pub = { id: true, nameEn: true, nameBn: true, slug: true } as const;

@Injectable()
export class LocationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
  ) {}

  // ─────────── Public (cached) ───────────

  async divisions() {
    return this.cache.wrap(await this.cache.key(NS, 'divisions'), TTL, () =>
      this.prisma.division.findMany({ where: { isActive: true }, orderBy, select: pub }),
    );
  }

  async districts(divisionId: number) {
    return this.cache.wrap(await this.cache.key(NS, `districts:${divisionId}`), TTL, () =>
      this.prisma.district.findMany({ where: { divisionId, isActive: true }, orderBy, select: { ...pub, divisionId: true } }),
    );
  }

  async upazilas(districtId: number) {
    return this.cache.wrap(await this.cache.key(NS, `upazilas:${districtId}`), TTL, () =>
      this.prisma.upazila.findMany({
        where: { districtId, isActive: true },
        orderBy,
        select: { ...pub, districtId: true, isCity: true },
      }),
    );
  }

  /** Divisions with their districts in one call — lets the app render the picker without extra round-trips. */
  async tree() {
    return this.cache.wrap(await this.cache.key(NS, 'tree'), TTL, () =>
      this.prisma.division.findMany({
        where: { isActive: true },
        orderBy,
        select: { ...pub, districts: { where: { isActive: true }, orderBy, select: pub } },
      }),
    );
  }

  // ─────────── Admin ───────────

  adminList(level: Level, parentId?: number) {
    switch (level) {
      case 'divisions':
        return this.prisma.division.findMany({ orderBy, include: { _count: { select: { districts: true, chambers: true } } } });
      case 'districts':
        return this.prisma.district.findMany({
          where: parentId ? { divisionId: parentId } : {},
          orderBy,
          include: { division: { select: { nameEn: true } }, _count: { select: { upazilas: true, chambers: true } } },
        });
      case 'upazilas':
        return this.prisma.upazila.findMany({
          where: parentId ? { districtId: parentId } : {},
          orderBy,
          include: { district: { select: { nameEn: true } }, _count: { select: { chambers: true } } },
        });
    }
  }

  async create(level: Level, dto: LocationDto, actor: AuthUser, ip?: string) {
    const base = {
      nameEn: dto.nameEn.trim(),
      nameBn: dto.nameBn.trim(),
      slug: slugify(dto.nameEn),
      isActive: dto.isActive ?? true,
      sortOrder: dto.sortOrder ?? 0,
    };
    let row: unknown;
    if (level === 'divisions') row = await this.prisma.division.create({ data: base });
    else if (level === 'districts') {
      if (!dto.parentId) throw new BadRequestException('parentId (divisionId) is required');
      row = await this.prisma.district.create({ data: { ...base, divisionId: dto.parentId } });
    } else {
      if (!dto.parentId) throw new BadRequestException('parentId (districtId) is required');
      row = await this.prisma.upazila.create({
        data: { ...base, slug: `${base.slug}-${dto.parentId}`, districtId: dto.parentId, isCity: dto.isCity ?? false },
      });
    }
    await this.afterWrite('create', level, row, actor, ip);
    return row;
  }

  async update(level: Level, id: number, dto: UpdateLocationDto, actor: AuthUser, ip?: string) {
    const data = {
      nameEn: dto.nameEn?.trim(),
      nameBn: dto.nameBn?.trim(),
      isActive: dto.isActive,
      sortOrder: dto.sortOrder,
    };
    let row: unknown;
    if (level === 'divisions') row = await this.prisma.division.update({ where: { id }, data });
    else if (level === 'districts') row = await this.prisma.district.update({ where: { id }, data });
    else row = await this.prisma.upazila.update({ where: { id }, data: { ...data, isCity: dto.isCity } });
    await this.afterWrite('update', level, row, actor, ip);
    return row;
  }

  private async afterWrite(action: string, level: Level, row: unknown, actor: AuthUser, ip?: string) {
    await this.cache.bump(NS, 'doctors');
    await this.audit.log({ actorId: actor.sub, action: `${level}.${action}`, entity: level, entityId: (row as { id: number }).id, after: row, ip });
  }
}

function parseLevel(level: string): Level {
  if (!(LEVELS as readonly string[]).includes(level)) throw new BadRequestException(`level must be one of ${LEVELS.join(', ')}`);
  return level as Level;
}

@ApiTags('Locations')
@Controller('locations')
export class LocationsController {
  constructor(private readonly svc: LocationsService) {}

  @Public() @Get('divisions') divisions() { return this.svc.divisions(); }
  @Public() @Get('tree') tree() { return this.svc.tree(); }
  @Public() @Get('divisions/:id/districts') districts(@Param('id', ParseIntPipe) id: number) { return this.svc.districts(id); }
  @Public() @Get('districts/:id/upazilas') upazilas(@Param('id', ParseIntPipe) id: number) { return this.svc.upazilas(id); }
}

@ApiTags('Admin · Locations')
@ApiBearerAuth()
@Roles(...ADMIN_ROLES)
@Controller('admin/locations')
export class AdminLocationsController {
  constructor(private readonly svc: LocationsService) {}

  @Get(':level')
  list(@Param('level') level: string, @Query() q: LevelQuery) {
    return this.svc.adminList(parseLevel(level), q.parentId);
  }

  @Post(':level')
  create(@Param('level') level: string, @Body() dto: LocationDto, @CurrentUser() u: AuthUser, @ClientIp() ip: string) {
    return this.svc.create(parseLevel(level), dto, u, ip);
  }

  @Patch(':level/:id')
  update(
    @Param('level') level: string,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateLocationDto,
    @CurrentUser() u: AuthUser,
    @ClientIp() ip: string,
  ) {
    return this.svc.update(parseLevel(level), id, dto, u, ip);
  }
}

@Module({ controllers: [LocationsController, AdminLocationsController], providers: [LocationsService] })
export class LocationsModule {}
