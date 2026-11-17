import { Body, Controller, Get, HttpCode, Module, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Role } from '@prisma/client';
import { ADMIN_ROLES, AuthUser, ClientIp, CurrentUser, Public, Roles } from '../common/decorators';
import { DoctorsModule } from '../doctors/doctors.module';
import { FeesModule } from '../fees/fees.module';
import { AdminAppointmentQueryDto, AdminStatusDto, CancelDto, CreateAppointmentDto, MyAppointmentsQueryDto, QuoteDto } from './appointments.dto';
import { AppointmentsService } from './appointments.service';

@ApiTags('Appointments')
@ApiBearerAuth()
@Controller('appointments')
export class AppointmentsController {
  constructor(private readonly svc: AppointmentsService) {}

  /** Server-calculated fee breakdown for the checkout screen. */
  @Public()
  @Post('quote')
  @HttpCode(200)
  quote(@Body() dto: QuoteDto) {
    return this.svc.quote(dto);
  }

  @Roles(Role.PATIENT)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post()
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateAppointmentDto) {
    return this.svc.create(u, dto);
  }

  @Roles(Role.PATIENT)
  @Get('me')
  mine(@CurrentUser() u: AuthUser, @Query() q: MyAppointmentsQueryDto) {
    return this.svc.mine(u, q);
  }

  @Roles(Role.PATIENT)
  @Get('me/:id')
  getMine(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.getMine(u, id);
  }

  @Roles(Role.PATIENT)
  @Post('me/:id/cancel')
  @HttpCode(200)
  cancel(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelDto) {
    return this.svc.cancelMine(u, id, dto.reason);
  }
}

@ApiTags('Admin · Appointments')
@ApiBearerAuth()
@Roles(...ADMIN_ROLES)
@Controller('admin/appointments')
export class AdminAppointmentsController {
  constructor(private readonly svc: AppointmentsService) {}

  @Get() list(@Query() q: AdminAppointmentQueryDto) { return this.svc.adminList(q); }

  @Patch(':id/status') status(
    @Param('id', ParseUUIDPipe) id: string, @Body() dto: AdminStatusDto, @CurrentUser() u: AuthUser, @ClientIp() ip: string,
  ) {
    return this.svc.adminSetStatus(id, dto, u, ip);
  }
}

@Module({
  imports: [DoctorsModule, FeesModule],
  controllers: [AppointmentsController, AdminAppointmentsController],
  providers: [AppointmentsService],
})
export class AppointmentsModule {}
