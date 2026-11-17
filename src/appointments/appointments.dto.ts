import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { AppointmentStatus, ConsultationType, Gender } from '@prisma/client';
import { PaginationDto } from '../common/pagination';

export class QuoteDto {
  @ApiProperty() @IsUUID() doctorId: string;
  @ApiProperty({ enum: ConsultationType }) @IsEnum(ConsultationType) type: ConsultationType;
}

export class CreateAppointmentDto extends QuoteDto {
  @ApiProperty({ example: '2026-11-20T11:00:00.000Z', description: 'startAt of a slot from GET /doctors/:id/slots' })
  @IsDateString()
  startAt: string;

  @ApiProperty({ example: 'Rahim Uddin' }) @IsString() @MinLength(2) @MaxLength(80) patientName: string;
  @ApiPropertyOptional({ example: 34 }) @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(120) patientAge?: number;
  @ApiPropertyOptional({ enum: Gender }) @IsOptional() @IsEnum(Gender) patientGender?: Gender;
  @ApiPropertyOptional({ example: 'Chest pain for 3 days' }) @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class MyAppointmentsQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: ['upcoming', 'past', 'cancelled', 'all'], default: 'all' })
  @IsOptional()
  @IsIn(['upcoming', 'past', 'cancelled', 'all'])
  tab?: 'upcoming' | 'past' | 'cancelled' | 'all';
}

export class CancelDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

export class AdminAppointmentQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: AppointmentStatus }) @IsOptional() @IsEnum(AppointmentStatus) status?: AppointmentStatus;
  @ApiPropertyOptional({ enum: ConsultationType }) @IsOptional() @IsEnum(ConsultationType) type?: ConsultationType;
  @ApiPropertyOptional() @IsOptional() @IsUUID() doctorId?: string;
  @ApiPropertyOptional({ example: '2026-11-01' }) @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) from?: string;
  @ApiPropertyOptional({ example: '2026-11-30' }) @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) to?: string;
}

export class AdminStatusDto {
  @ApiProperty({ enum: AppointmentStatus }) @IsEnum(AppointmentStatus) status: AppointmentStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) reason?: string;
}
