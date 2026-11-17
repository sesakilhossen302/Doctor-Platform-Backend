# Backend — NestJS API

Modular monolith: one deployable app, one module per domain (`src/<module>`). Mobile app and admin never touch the database directly.

```
src/
  auth/          OTP login (patients), password login (staff), JWT + rotating refresh tokens
  users/         patient profile (owner-only)
  locations/     division → district → upazila (public cached reads + admin CRUD)
  catalog/       specialties, designations, hospitals
  doctors/       public search/detail, admin CRUD, chambers, weekly schedules, leave, slot generation
  appointments/  quote, book (atomic slot hold), my bookings, cancel, admin status changes, hold expiry
  fees/          server-side fee calculation + admin platform-fee settings
  admin/         dashboard stats, patients, staff, audit log
  payments/      payment state machine; DEMO provider now, bKash provider next (PAYMENT_PROVIDER)
  agora/         RTC token issuing — only to participants of that channel; certificate stays on server
  realtime/      Socket.IO gateway (/realtime): call:incoming, call:status, callrequest:status, queue:changed
  consultations/ doctor ↔ patient call state machine (RINGING → ONGOING → ENDED …) + doctor-app API (/doctor/*)
  call-center/   instant calls: pay → queue → agent → transfer to doctor (same Agora channel)
  audit/         who-changed-what log
  cache/         Redis or in-memory read-through cache with stampede protection
  common/        guards (JWT, roles), filters, utils (Asia/Dhaka time)
prisma/          schema.prisma, migrations, seed.ts
scripts/         dev-db (portable Postgres), smoke-test, loadtest
```

## Commands

| Command | What it does |
|---|---|
| `npm run db:dev` | Portable PostgreSQL on :5432 (no install needed) |
| `npm run setup` | Apply migrations + seed demo data |
| `npm run build && npm start` | Production build & run (single process) |
| `npm run start:dev` | Watch mode |
| `npm run start:cluster` | PM2 cluster — one process per CPU core |
| `npm run smoke` | End-to-end checks (needs `THROTTLE_SKIP=true` on the API) |
| `node scripts/calls-test.js` | Payments, calls, call center and realtime events (needs any `AGORA_APP_ID`) |
| `npm run loadtest` | Load test hot endpoints |
| `npx prisma migrate dev --name <change>` | Create a new migration after editing the schema |

## Environment
See [.env.example](.env.example). For production, at minimum:
- `NODE_ENV=production`, a random 32+ char `JWT_ACCESS_SECRET`, `OTP_DEV_MODE=false` (the app refuses to start otherwise)
- `REDIS_URL` (shared cache across processes/servers)
- `DATABASE_URL` pointing to managed PostgreSQL behind PgBouncer
- `CORS_ORIGINS` = the admin dashboard's domain
- `SWAGGER_ENABLED=false` (or protect `/docs`)

## Key rules enforced in code
- Only `ACTIVE` + `VERIFIED` doctors are visible to patients.
- `UNIQUE(doctorId, startAt)` on slots → double-booking is impossible, even across servers.
- New bookings are `PENDING_PAYMENT` with a hold (`SLOT_HOLD_MINUTES`); unpaid holds expire automatically. Admins cannot mark an unpaid booking as completed.
- All fees are calculated on the server.
- Every admin change (doctor, fee, booking, staff, location) is written to `audit_logs`.
- Times are stored in UTC; schedules and dates are Asia/Dhaka.
