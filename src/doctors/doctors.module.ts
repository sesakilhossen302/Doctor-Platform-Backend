import { Body, Controller, Delete, Get, Module, Param, ParseBoolPipe, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ConsultationType } from '@prisma/client';
import { ADMIN_ROLES, AuthUser, ClientIp, CurrentUser, Public, Roles } from '../common/decorators';
import {
  AdminDoctorQueryDto,
  AppLoginDto,
  ChamberDto,
  DoctorDto,
  DoctorQueryDto,
  DoctorStatusDto,
  DoctorVerificationDto,
  LeaveDto,
  ReplaceSchedulesDto,
  SlotsQueryDto,
  UpdateChamberDto,
  UpdateDoctorDto,
} from './doctors.dto';
import { DoctorsService } from './doctors.service';
import { SlotsService } from './slots.service';

@ApiTags('Doctors')
@Controller('doctors')
export class DoctorsController {
  constructor(
    private readonly doctors: DoctorsService,
    private readonly slots: SlotsService,
  ) {}

  /** Search & filter bookable doctors. Cached for 60 s per unique query. */
  @Public()
  @Get()
  list(@Query() q: DoctorQueryDto) {
    return this.doctors.list(q);
  }

  @Public()
  @Get(':idOrSlug')
  detail(@Param('idOrSlug') idOrSlug: string) {
    return this.doctors.detail(idOrSlug);
  }

  /** Bookable slots for one Dhaka calendar date. */
  @Public()
  @Get(':idOrSlug/slots')
  async slotsForDate(@Param('idOrSlug') idOrSlug: string, @Query() q: SlotsQueryDto) {
    return this.slots.forDate(await this.doctors.publicIdOrThrow(idOrSlug), q.date, q.type);
  }

  /** Dates in the next 14 days that still have free slots. */
  @Public()
  @Get(':idOrSlug/available-dates')
  async availableDates(@Param('idOrSlug') idOrSlug: string, @Query('type') type?: ConsultationType) {
    return this.slots.availableDates(await this.doctors.publicIdOrThrow(idOrSlug), type);
  }
}

@ApiTags('Admin · Doctors')
@ApiBearerAuth()
@Roles(...ADMIN_ROLES)
@Controller('admin/doctors')
export class AdminDoctorsController {
  constructor(private readonly doctors: DoctorsService) {}

  @Get() list(@Query() q: AdminDoctorQueryDto) { return this.doctors.adminList(q); }
  @Get(':id') get(@Param('id', ParseUUIDPipe) id: string) { return this.doctors.adminGet(id); }

  @Post() create(@Body() dto: DoctorDto, @CurrentUser() u: AuthUser, @ClientIp() ip: string) {
    return this.doctors.create(dto, u, ip);
  }

  @Patch(':id') update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDoctorDto, @CurrentUser() u: AuthUser, @ClientIp() ip: string) {
    return this.doctors.update(id, dto, u, ip);
  }

  /** Doctors are never deleted — set status ARCHIVED instead. */
  @Patch(':id/status') status(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DoctorStatusDto, @CurrentUser() u: AuthUser, @ClientIp() ip: string) {
    return this.doctors.setStatus(id, dto.status, u, ip);
  }

  @Patch(':id/verification') verify(
    @Param('id', ParseUUIDPipe) id: string, @Body() dto: DoctorVerificationDto, @CurrentUser() u: AuthUser, @ClientIp() ip: string,
  ) {
    return this.doctors.setVerification(id, dto, u, ip);
  }

  @Patch(':id/available-now/:value') availableNow(
    @Param('id', ParseUUIDPipe) id: string, @Param('value', ParseBoolPipe) value: boolean, @CurrentUser() u: AuthUser, @ClientIp() ip: string,
  ) {
    return this.doctors.setAvailableNow(id, value, u, ip);
  }

  /** Phone number the doctor uses to log in to the doctor app (OTP). */
  @Put(':id/app-login') appLogin(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AppLoginDto, @CurrentUser() u: AuthUser, @ClientIp() ip: string) {
    return this.doctors.linkAppLogin(id, dto, u, ip);
  }

  @Post(':id/chambers') addChamber(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ChamberDto, @CurrentUser() u: AuthUser, @ClientIp() ip: string) {
    return this.doctors.addChamber(id, dto, u, ip);
  }

  @Patch(':id/chambers/:chamberId') updateChamber(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('chamberId', ParseUUIDPipe) chamberId: string,
    @Body() dto: UpdateChamberDto,
    @CurrentUser() u: AuthUser,
    @ClientIp() ip: string,
  ) {
    return this.doctors.updateChamber(id, chamberId, dto, u, ip);
  }

  /** Replace the doctor’s whole weekly schedule in one atomic call. */
  @Put(':id/schedules') schedules(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReplaceSchedulesDto, @CurrentUser() u: AuthUser, @ClientIp() ip: string) {
    return this.doctors.replaceSchedules(id, dto, u, ip);
  }

  @Post(':id/leaves') addLeave(@Param('id', ParseUUIDPipe) id: string, @Body() dto: LeaveDto, @CurrentUser() u: AuthUser, @ClientIp() ip: string) {
    return this.doctors.addLeave(id, dto, u, ip);
  }

  @Delete(':id/leaves/:leaveId') removeLeave(
    @Param('id', ParseUUIDPipe) id: string, @Param('leaveId', ParseUUIDPipe) leaveId: string, @CurrentUser() u: AuthUser, @ClientIp() ip: string,
  ) {
    return this.doctors.removeLeave(id, leaveId, u, ip);
  }
}

@Module({
  controllers: [DoctorsController, AdminDoctorsController],
  providers: [DoctorsService, SlotsService],
  exports: [DoctorsService, SlotsService],
})
export class DoctorsModule {}
