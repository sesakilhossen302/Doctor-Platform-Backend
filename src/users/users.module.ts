import { Body, Controller, Get, Injectable, Module, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEmail, IsEnum, IsInt, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { Gender, Role } from '@prisma/client';
import { AuthUser, CurrentUser, Roles } from '../common/decorators';
import { dateOnly } from '../common/utils';
import { PrismaService } from '../prisma/prisma.service';

class UpdateProfileDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(80) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() email?: string;
  @ApiPropertyOptional({ example: '1992-04-15' }) @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) dateOfBirth?: string;
  @ApiPropertyOptional({ enum: Gender }) @IsOptional() @IsEnum(Gender) gender?: Gender;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) address?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(30) emergencyContact?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() divisionId?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() districtId?: number;
}

const PROFILE_SELECT = {
  id: true,
  phone: true,
  email: true,
  name: true,
  role: true,
  createdAt: true,
  patient: {
    select: { dateOfBirth: true, gender: true, address: true, emergencyContact: true, divisionId: true, districtId: true },
  },
} as const;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  profile(userId: string) {
    return this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: PROFILE_SELECT });
  }

  /** Owner-only: a patient can only ever update their own profile. */
  async update(userId: string, dto: UpdateProfileDto) {
    const { name, email, dateOfBirth, ...patient } = dto;
    const patientData = { ...patient, ...(dateOfBirth && { dateOfBirth: dateOnly(dateOfBirth) }) };
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        name: name?.trim(),
        email: email?.toLowerCase(),
        patient: { upsert: { create: patientData, update: patientData } },
      },
      select: PROFILE_SELECT,
    });
  }
}

@ApiTags('Profile')
@ApiBearerAuth()
@Roles(Role.PATIENT)
@Controller('users/me')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get() get(@CurrentUser() u: AuthUser) { return this.users.profile(u.sub); }
  @Patch() update(@CurrentUser() u: AuthUser, @Body() dto: UpdateProfileDto) { return this.users.update(u.sub, dto); }
}

@Module({ controllers: [UsersController], providers: [UsersService] })
export class UsersModule {}
