import compress from '@fastify/compress';
import helmet from '@fastify/helmet';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';

async function bootstrap() {
  // Fastify handles roughly 2x the requests/sec of Express on the same hardware.
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true, bodyLimit: 1_048_576 }),
    // bodyParser:false → we register our own JSON parser below (accepts empty bodies).
    { bodyParser: false, logger: process.env.NODE_ENV === 'production' ? ['error', 'warn', 'log'] : undefined },
  );

  // Treat an empty JSON body as {} — many mobile HTTP clients send `content-type: application/json`
  // on POSTs without a body (e.g. "accept call"), which Fastify would otherwise reject.
  const fastify = app.getHttpAdapter().getInstance();
  fastify.removeContentTypeParser('application/json');
  fastify.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 1_048_576 }, (_req, body, done) => {
    if (body === '' || body === undefined) return done(null, {});
    try {
      done(null, JSON.parse(body as string));
    } catch {
      const err = new Error('Invalid JSON body') as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await app.register(helmet as any, { contentSecurityPolicy: false });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await app.register(compress as any, { threshold: 1024, encodings: ['br', 'gzip'] });

  const origins = (process.env.CORS_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  // Entries like "https://*.vercel.app" allow any subdomain (e.g. Vercel preview deployments).
  const allowed = origins.map((o) =>
    o.includes('*') ? new RegExp(`^${o.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-z0-9-]+')}$`) : o,
  );
  // @fastify/cors only allows GET/HEAD/POST by default — the dashboard also needs PUT/PATCH/DELETE.
  app.enableCors({
    origin: allowed.length ? allowed : true,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  app.setGlobalPrefix('api/v1', { exclude: ['health'] });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: false } }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useWebSocketAdapter(new IoAdapter(app)); // Socket.IO at /socket.io, namespace /realtime
  app.enableShutdownHooks();

  if (process.env.SWAGGER_ENABLED === 'true') {
    const config = new DocumentBuilder()
      .setTitle('Doctor Appointment & Telemedicine API')
      .setDescription('Patient app, admin dashboard and call-center API. All times are UTC ISO-8601; schedules use Asia/Dhaka.')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config), {
      swaggerOptions: { persistAuthorization: true },
    });
  }

  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port, '0.0.0.0');
  Logger.log(`API ready on http://localhost:${port}/api/v1  ·  docs: /docs  ·  pid ${process.pid}`, 'Bootstrap');
}

bootstrap();
