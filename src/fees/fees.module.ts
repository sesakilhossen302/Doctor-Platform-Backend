import { BadRequestException, Body, Controller, Get, Injectable, Module, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsBoolean, IsEnum, IsInt, IsOptional, Max, Min, ValidateNested } from 'class-validator';
import { ConsultationType, FeeMode, FeeServiceType } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { CacheService } from '../cache/cache.service';
import { ADMIN_ROLES, AuthUser, ClientIp, CurrentUser, Roles } from '../common/decorators';
import { PrismaService } from '../prisma/prisma.service';

export interface FeeBreakdown {
  serviceFee: number;
  platformFee: number;
  total: number;
  currency: 'BDT';
}

class FeeSettingDto {
  @ApiProperty({ enum: FeeServiceType }) @IsEnum(FeeServiceType) serviceType: FeeServiceType;
  @ApiProperty({ enum: FeeMode }) @IsEnum(FeeMode) mode: FeeMode;
  @ApiProperty({ description: 'FIXED: taka · PERCENT: 0-100' }) @Type(() => Number) @IsInt() @Min(0) @Max(100000) value: number;
  @ApiProperty() @IsOptional() @IsBoolean() isActive?: boolean;
}

class FeeSettingsDto {
  @ApiProperty({ type: [FeeSettingDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => FeeSettingDto)
  settings: FeeSettingDto[];
}

/** All money math happens here, on the server. Clients only display what this returns. */
@Injectable()
export class FeesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
  ) {}

  private async settings() {
    return this.cache.wrap('fees:settings', 300, () => this.prisma.platformFeeSetting.findMany());
  }

  static serviceTypeFor(type: ConsultationType): FeeServiceType {
    return type === ConsultationType.CHAMBER ? FeeServiceType.APPOINTMENT_CHAMBER : FeeServiceType.APPOINTMENT_ONLINE;
  }

  async calculate(serviceType: FeeServiceType, serviceFee: number): Promise<FeeBreakdown> {
    const s = (await this.settings()).find((x) => x.serviceType === serviceType && x.isActive);
    let platformFee = 0;
    if (s) platformFee = s.mode === FeeMode.FIXED ? s.value : Math.round((serviceFee * s.value) / 100);
    return { serviceFee, platformFee, total: serviceFee + platformFee, currency: 'BDT' };
  }

  list() {
    return this.prisma.platformFeeSetting.findMany({ orderBy: { id: 'asc' } });
  }

  async save(dto: FeeSettingsDto, u: AuthUser, ip?: string) {
    for (const s of dto.settings) {
      if (s.mode === FeeMode.PERCENT && s.value > 100) throw new BadRequestException('Percent value must be 0-100');
    }
    const before = await this.list();
    await this.prisma.$transaction(
      dto.settings.map((s) =>
        this.prisma.platformFeeSetting.upsert({
          where: { serviceType: s.serviceType },
          create: { serviceType: s.serviceType, mode: s.mode, value: s.value, isActive: s.isActive ?? true },
          update: { mode: s.mode, value: s.value, isActive: s.isActive ?? true },
        }),
      ),
    );
    await this.cache.del('fees:settings');
    const after = await this.list();
    await this.audit.log({ actorId: u.sub, action: 'fees.update', entity: 'platform_fee_settings', before, after, ip });
    return after;
  }
}

@ApiTags('Admin · Fees')
@ApiBearerAuth()
@Roles(...ADMIN_ROLES)
@Controller('admin/fees')
export class AdminFeesController {
  constructor(private readonly fees: FeesService) {}

  @Get() list() { return this.fees.list(); }
  @Put() save(@Body() dto: FeeSettingsDto, @CurrentUser() u: AuthUser, @ClientIp() ip: string) {
    return this.fees.save(dto, u, ip);
  }
}

@Module({ controllers: [AdminFeesController], providers: [FeesService], exports: [FeesService] })
export class FeesModule {}
