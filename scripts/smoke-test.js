/**
 * End-to-end smoke test against a running API.
 *   node scripts/smoke-test.js [baseUrl]
 * Requires OTP_DEV_MODE=true (fixed code 123456), THROTTLE_SKIP=true (20 simulated users share one IP)
 * and seeded demo data.
 */
const BASE = (process.argv[2] || 'http://localhost:4000') + '/api/v1';

async function api(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const ok = (cond, msg) => {
  console.log(`${cond ? '✔' : '✘'} ${msg}`);
  if (!cond) process.exitCode = 1;
};

async function login(phone) {
  await api('POST', '/auth/otp/request', { phone });
  const r = await api('POST', '/auth/otp/verify', { phone, code: '123456' });
  return r.data.accessToken;
}

(async () => {
  // 1. Patient login via OTP
  const phone = `017${String(Date.now()).slice(-8)}`;
  const otp = await api('POST', '/auth/otp/request', { phone });
  ok(otp.status === 200 && otp.data.devCode === '123456', 'OTP requested (dev mode)');
  const wrong = await api('POST', '/auth/otp/verify', { phone, code: '000000' });
  ok(wrong.status === 400, 'Wrong OTP rejected');
  const v = await api('POST', '/auth/otp/verify', { phone, code: '123456' });
  ok(v.status === 200 && v.data.accessToken && v.data.isNewUser, 'OTP verified, new patient created');
  const token = v.data.accessToken;

  const ref = await api('POST', '/auth/refresh', { refreshToken: v.data.refreshToken });
  ok(ref.status === 200 && ref.data.accessToken, 'Refresh token rotated');
  const reuse = await api('POST', '/auth/refresh', { refreshToken: v.data.refreshToken });
  ok(reuse.status === 401, 'Used refresh token cannot be reused');

  // 2. Find a doctor offering video consults and a free slot
  const docs = await api('GET', '/doctors?type=ONLINE_VIDEO&limit=5');
  ok(docs.status === 200 && docs.data.items.length > 0, `Doctor search (${docs.data.total} online doctors)`);
  const doctor = docs.data.items[0];
  const dates = await api('GET', `/doctors/${doctor.id}/available-dates?type=ONLINE_VIDEO`);
  ok(dates.status === 200 && dates.data.length > 0, `Available dates: ${dates.data.slice(0, 3).map((d) => d.date).join(', ')}…`);
  const day = await api('GET', `/doctors/${doctor.id}/slots?date=${dates.data[0].date}&type=ONLINE_VIDEO`);
  const slot = day.data.slots.find((s) => s.available);
  ok(!!slot, `Free slot found ${slot && slot.time} (Dhaka)`);

  // 3. Server-side quote
  const quote = await api('POST', '/appointments/quote', { doctorId: doctor.id, type: 'ONLINE_VIDEO' });
  ok(quote.status === 200 && quote.data.total === quote.data.serviceFee + quote.data.platformFee, `Fee: ${quote.data.serviceFee} + ${quote.data.platformFee} = ৳${quote.data.total}`);

  // 4. Concurrency: 20 different patients try to book the SAME slot at the same moment
  const tokens = await Promise.all(
    Array.from({ length: 20 }, (_, i) => login(`018${String(Date.now() + i * 7).slice(-8)}`)),
  );
  const attempts = await Promise.all(
    tokens.map((t) =>
      api('POST', '/appointments', { doctorId: doctor.id, type: 'ONLINE_VIDEO', startAt: slot.startAt, patientName: 'Race Test' }, t),
    ),
  );
  const byStatus = attempts.reduce((m, a) => ((m[a.status] = (m[a.status] || 0) + 1), m), {});
  console.log('  responses by HTTP status:', JSON.stringify(byStatus));
  const won = attempts.filter((a) => a.status === 201);
  const lost = attempts.filter((a) => a.status === 409 || a.status === 400);
  ok(won.length === 1 && lost.length === 19, `Double-booking prevented: ${won.length} booked, ${lost.length} rejected out of 20 concurrent requests`);
  ok(won[0] && won[0].data.status === 'PENDING_PAYMENT' && /^DA-/.test(won[0].data.code), `Booking ${won[0] && won[0].data.code} is PENDING_PAYMENT with a hold`);

  const after = await api('GET', `/doctors/${doctor.id}/slots?date=${dates.data[0].date}&type=ONLINE_VIDEO`);
  ok(after.data.slots.find((s) => s.startAt === slot.startAt).available === false, 'Slot now shows as unavailable');

  // 5. Ownership: patient A cannot read patient B's booking
  const other = await api('GET', `/appointments/me/${won[0].data.id}`, null, token);
  ok(other.status === 404, 'Patients cannot see other patients’ bookings');

  // 6. Patient cannot call admin APIs
  const forbidden = await api('GET', '/admin/dashboard', null, token);
  ok(forbidden.status === 403, 'Patient blocked from admin API (RBAC)');

  // 7. Admin
  const admin = await api('POST', '/auth/admin/login', { email: 'admin@demo.local', password: 'Admin@12345' });
  ok(admin.status === 200, 'Admin login');
  const dash = await api('GET', '/admin/dashboard', null, admin.data.accessToken);
  ok(dash.status === 200 && dash.data.totals.doctors > 0, `Dashboard: ${dash.data.totals.doctors} doctors, ${dash.data.totals.patients} patients, ${dash.data.totals.pendingPayment} pending payments`);
  const fake = await api('PATCH', `/admin/appointments/${won[0].data.id}/status`, { status: 'COMPLETED' }, admin.data.accessToken);
  ok(fake.status === 400, 'Unpaid booking cannot be marked completed');
  const cancel = await api('PATCH', `/admin/appointments/${won[0].data.id}/status`, { status: 'CANCELLED', reason: 'smoke test' }, admin.data.accessToken);
  ok(cancel.status === 200 && cancel.data.status === 'CANCELLED', 'Admin cancelled booking');
  const freed = await api('GET', `/doctors/${doctor.id}/slots?date=${dates.data[0].date}&type=ONLINE_VIDEO`);
  ok(freed.data.slots.find((s) => s.startAt === slot.startAt).available === true, 'Cancelled slot is free again');
  const audit = await api('GET', '/admin/audit-logs?limit=3', null, admin.data.accessToken);
  ok(audit.status === 200 && audit.data.items.some((l) => l.action === 'appointment.cancel'), 'Cancellation recorded in audit log');

  console.log(process.exitCode ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
})();
