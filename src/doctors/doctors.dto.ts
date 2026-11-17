import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsEmail,
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ConsultationType, DoctorStatus, Gender, VerificationStatus } from '@prisma/client';
import { PaginationDto } from '../common/pagination';

export const DOCTOR_SORTS = ['rating', 'fee_asc', 'fee_desc', 'experience'] as const;

export class DoctorQueryDto extends PaginationDto {
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() divisionId?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() districtId?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() upazilaId?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() specialtyId?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() hospitalId?: number;
  @ApiPropertyOptional({ enum: ConsultationType }) @IsOptional() @IsEnum(ConsultationType) type?: ConsultationType;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(0) maxFee?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(0) minExperience?: number;
  @ApiPropertyOptional({ enum: DOCTOR_SORTS, default: 'rating' }) @IsOptional() @IsIn(DOCTOR_SORTS) sort?: (typeof DOCTOR_SORTS)[number];
  @ApiPropertyOptional({ description: 'Only doctors available for an instant call now' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  availableNow?: boolean;
}

export class AdminDoctorQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: DoctorStatus }) @IsOptional() @IsEnum(DoctorStatus) status?: DoctorStatus;
  @ApiPropertyOptional({ enum: VerificationStatus }) @IsOptional() @IsEnum(VerificationStatus) verificationStatus?: VerificationStatus;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() specialtyId?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() districtId?: number;
}

export class DoctorDto {
  @ApiProperty({ example: 'Dr. Rafiqul Islam' }) @IsString() @MaxLength(120) nameEn: string;
  @ApiPropertyOptional({ example: 'ডা. রফিকুল ইসলাম' }) @IsOptional() @IsString() @MaxLength(120) nameBn?: string;
  @ApiPropertyOptional({ enum: Gender }) @IsOptional() @IsEnum(Gender) gender?: Gender;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) photoUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(3000) bio?: string;
  @ApiPropertyOptional({ example: 'MBBS, FCPS (Medicine)' }) @IsOptional() @IsString() @MaxLength(300) degrees?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() designationId?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(70) experienceYears?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(30) bmdcNumber?: string;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(6) @IsString({ each: true }) languages?: string[];
  @ApiPropertyOptional({ enum: ConsultationType, isArray: true })
  @IsOptional()
  @IsArray()
  @IsEnum(ConsultationType, { each: true })
  consultationTypes?: ConsultationType[];
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100000) onlineFee?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100000) chamberFee?: number;
  @ApiPropertyOptional({ type: [Number], description: 'First id = primary specialty' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @Type(() => Number)
  @IsInt({ each: true })
  specialtyIds?: number[];
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isDemo?: boolean;
}
export class UpdateDoctorDto extends PartialType(DoctorDto) {}

export class DoctorStatusDto {
  @ApiProperty({ enum: DoctorStatus }) @IsEnum(DoctorStatus) status: DoctorStatus;
}

export class DoctorVerificationDto {
  @ApiProperty({ enum: VerificationStatus }) @IsEnum(VerificationStatus) verificationStatus: VerificationStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class ChamberDto {
  @ApiProperty() @IsString() @MaxLength(150) name: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) address?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() hospitalId?: number;
  @ApiProperty() @Type(() => Number) @IsInt() divisionId: number;
  @ApiProperty() @Type(() => Number) @IsInt() districtId: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() upazilaId?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}
export class UpdateChamberDto extends PartialType(ChamberDto) {}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export class ScheduleItemDto {
  @ApiProperty({ enum: ConsultationType }) @IsEnum(ConsultationType) type: ConsultationType;
  @ApiPropertyOptional({ description: 'Required for CHAMBER schedules' }) @IsOptional() @IsUUID() chamberId?: string;
  @ApiProperty({ description: '0 = Sunday … 6 = Saturday' }) @Type(() => Number) @IsInt() @Min(0) @Max(6) dayOfWeek: number;
  @ApiProperty({ example: '17:00' }) @Matches(HHMM) startTime: string;
  @ApiProperty({ example: '21:00' }) @Matches(HHMM) endTime: string;
  @ApiProperty({ example: 15 }) @Type(() => Number) @IsInt() @IsIn([5, 10, 15, 20, 30, 45, 60]) slotMinutes: number;
}

export class ReplaceSchedulesDto {
  @ApiProperty({ type: [ScheduleItemDto] })
  @IsArray()
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => ScheduleItemDto)
  schedules: ScheduleItemDto[];
}

export class LeaveDto {
  @ApiProperty({ example: '2026-12-16' }) @Matches(/^\d{4}-\d{2}-\d{2}$/) date: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) reason?: string;
}

/** Doctor-app login: a mobile number and/or an email (OTP goes to whichever the doctor enters). */
export class AppLoginDto {
  @ApiPropertyOptional({ example: '01900000001' })
  @IsOptional()
  @Matches(/^(\+?880|0)1[3-9]\d{8}$/, { message: 'Enter a valid Bangladeshi mobile number' })
  phone?: string;

  @ApiPropertyOptional({ example: 'doctor@gmail.com' })
  @IsOptional()
  @IsEmail({}, { message: 'Enter a valid email address' })
  email?: string;
}

export class SlotsQueryDto {
  @ApiProperty({ example: '2026-11-20', description: 'Asia/Dhaka calendar date' }) @Matches(/^\d{4}-\d{2}-\d{2}$/) date: string;
  @ApiPropertyOptional({ enum: ConsultationType }) @IsOptional() @IsEnum(ConsultationType) type?: ConsultationType;
}
