import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AdminModule } from './admin/admin.module';
import { AgoraModule } from './agora/agora.module';
import { CallCenterModule } from './call-center/call-center.module';
import { ConsultationsModule } from './consultations/consultations.module';
import { PaymentsModule } from './payments/payments.module';
import { RealtimeModule } from './realtime/realtime.gateway';
import { SettingsModule } from './settings/settings.module';
import { AppointmentsModule } from './appointments/appointments.module';
import { AuditModule } from './audit/audit.service';
import { AuthModule } from './auth/auth.module';
import { CacheModule } from './cache/cache.module';
import { CatalogModule } from './catalog/catalog.module';
import { JwtAuthGuard, RolesGuard } from './common/guards';
import { DoctorsModule } from './doctors/doctors.module';
import { FeesModule } from './fees/fees.module';
import { HealthModule } from './health/health.module';
import { LocationsModule } from './locations/locations.module';
import { PrismaModule } from './prisma/prisma.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true }),
    // Default: 300 requests / minute / IP. Sensitive routes (OTP, booking) set stricter limits.
    // THROTTLE_SKIP=true is ONLY for local load tests (many simulated users share one IP).
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60_000, limit: 300 }],
      skipIf: () => process.env.THROTTLE_SKIP === 'true' && process.env.NODE_ENV !== 'production',
    }),
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const secret = config.get<string>('JWT_ACCESS_SECRET');
        if (!secret || secret.length < 32) throw new Error('JWT_ACCESS_SECRET must be at least 32 characters');
        return { secret, signOptions: { expiresIn: (config.get('JWT_ACCESS_TTL') ?? '15m') as never } };
      },
    }),
    PrismaModule,
    CacheModule,
    AuditModule,
    HealthModule,
    AuthModule,
    UsersModule,
    LocationsModule,
    CatalogModule,
    FeesModule,
    DoctorsModule,
    AppointmentsModule,
    AdminModule,
    RealtimeModule,
    SettingsModule,
    AgoraModule,
    PaymentsModule,
    ConsultationsModule,
    CallCenterModule,
  ],
  providers: [
    // Order matters: rate-limit → authenticate → authorise.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
