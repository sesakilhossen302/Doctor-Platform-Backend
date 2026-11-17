/**
 * End-to-end test: demo payment → doctor call (ring/accept/end) → call center (queue/accept/transfer/complete),
 * including the real-time Socket.IO events each side receives.
 *   node scripts/calls-test.js [baseUrl]
 * Needs: seeded data (doctor logins 0190000000x), OTP_DEV_MODE=true, THROTTLE_SKIP=true,
 *        PAYMENT_PROVIDER=demo, CONSULT_JOIN_ANYTIME=true, and any AGORA_APP_ID.
 */
const { io } = require('socket.io-client');

const ORIGIN = process.argv[2] || 'http://localhost:4000';
const BASE = `${ORIGIN}/api/v1`;

async function api(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const ok = (cond, msg, extra) => {
  console.log(`${cond ? '✔' : '✘'} ${msg}${!cond && extra ? ' → ' + JSON.stringify(extra).slice(0, 300) : ''}`);
  if (!cond) process.exitCode = 1;
};
async function otpLogin(phone) {
  await api('POST', '/auth/otp/request', { phone });
  return (await api('POST', '/auth/otp/verify', { phone, code: '123456' })).data;
}
function listen(token) {
  const events = [];
  const socket = io(`${ORIGIN}/realtime`, { auth: { token }, transports: ['websocket'] });
  socket.onAny((event, payload) => events.push({ event, payload }));
  const waitFor = (event, pred = () => true, ms = 5000) =>
    new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        const hit = events.find((e) => e.event === event && pred(e.payload));
        if (hit) return resolve(hit.payload);
        if (Date.now() - t0 > ms) return resolve(null);
        setTimeout(tick, 50);
      };
      tick();
    });
  const ready = new Promise((r) => socket.on('connect', r));
  return { socket, waitFor, ready };
}

(async () => {
  // ── Logins ──
  const patient = await otpLogin(`015${String(Date.now()).slice(-8)}`);
  const doctor = await otpLogin('01900000001');
  ok(doctor.user && doctor.user.role === 'DOCTOR', 'Doctor logs in to the doctor app with OTP (role DOCTOR)', doctor);
  const me = await api('GET', '/doctor/me', null, doctor.accessToken);
  ok(me.status === 200 && me.data.doctor, `Doctor app profile: ${me.data.doctor && me.data.doctor.nameEn}`, me.data);
  const doctorId = me.data.doctor.id;
  await api('PATCH', '/doctor/availability', { isAvailableNow: true }, doctor.accessToken);

  const pSock = listen(patient.accessToken);
  const dSock = listen(doctor.accessToken);
  await Promise.all([pSock.ready, dSock.ready]);
  ok(true, 'Patient & doctor connected to realtime socket');

  // ── Book + pay ──
  const dates = (await api('GET', `/doctors/${doctorId}/available-dates?type=ONLINE_VIDEO`)).data;
  const day = (await api('GET', `/doctors/${doctorId}/slots?date=${dates[0].date}&type=ONLINE_VIDEO`)).data;
  const slot = day.slots.find((s) => s.available);
  const booking = (await api('POST', '/appointments', { doctorId, type: 'ONLINE_VIDEO', startAt: slot.startAt, patientName: 'Call Test' }, patient.accessToken)).data;
  ok(booking.status === 'PENDING_PAYMENT', `Booked ${booking.code} (PENDING_PAYMENT)`, booking);

  const early = await api('POST', '/consultations', { appointmentId: booking.id }, patient.accessToken);
  ok(early.status === 400, 'Cannot call before paying', early.data);

  const pay = await api('POST', `/payments/appointments/${booking.id}`, null, patient.accessToken);
  ok(pay.status === 200 && pay.data.payment.status === 'INITIATED' && pay.data.next.type === 'demo-confirm', `Payment initiated ${pay.data.payment && pay.data.payment.code} ৳${pay.data.payment && pay.data.payment.amount}`, pay.data);
  const again = await api('POST', `/payments/appointments/${booking.id}`, null, patient.accessToken);
  ok(again.data.payment.id === pay.data.payment.id, 'Double tap re-uses the same payment (no double charge)');
  const confirm = await api('POST', `/payments/${pay.data.payment.id}/demo-confirm`, null, patient.accessToken);
  ok(confirm.status === 200 && confirm.data.status === 'SUCCESS' && confirm.data.trxId, `Payment SUCCESS, trx ${confirm.data.trxId}`, confirm.data);
  const appt = (await api('GET', `/appointments/me/${booking.id}`, null, patient.accessToken)).data;
  ok(appt.status === 'CONFIRMED', 'Booking is now CONFIRMED (server-side)', appt);

  // ── Doctor call ──
  const call = await api('POST', '/consultations', { appointmentId: booking.id }, patient.accessToken);
  ok(call.status === 201 && call.data.status === 'RINGING' && call.data.media === 'VIDEO', 'Patient starts video call → RINGING', call.data);
  const incoming = await dSock.waitFor('call:incoming', (p) => p.id === call.data.id);
  ok(!!incoming, 'Doctor receives call:incoming in real time');

  const tokenEarly = await api('GET', `/calls/token?channel=${call.data.channelName}`, null, patient.accessToken);
  ok(tokenEarly.status === 200 && tokenEarly.data.uid > 0, 'Patient gets Agora credentials for own channel', tokenEarly.data);
  const stranger = await otpLogin(`016${String(Date.now()).slice(-8)}`);
  const denied = await api('GET', `/calls/token?channel=${call.data.channelName}`, null, stranger.accessToken);
  ok(denied.status === 403, 'Other users cannot get a token for this call', denied.data);

  const acc = await api('POST', `/consultations/${call.data.id}/accept`, null, doctor.accessToken);
  ok(acc.status === 200 && acc.data.status === 'ONGOING', 'Doctor accepts → ONGOING', acc.data);
  ok(!!(await pSock.waitFor('call:status', (p) => p.id === call.data.id && p.status === 'ONGOING')), 'Patient notified: call accepted');
  const dTok = await api('GET', `/calls/token?channel=${call.data.channelName}`, null, doctor.accessToken);
  ok(dTok.status === 200 && dTok.data.uid !== tokenEarly.data.uid, 'Doctor gets own Agora uid/token');
  const acc2 = await api('POST', `/consultations/${call.data.id}/accept`, null, doctor.accessToken);
  ok(acc2.status === 400, 'Accepting twice is rejected');

  await new Promise((r) => setTimeout(r, 1200));
  const end = await api('POST', `/consultations/${call.data.id}/end`, null, patient.accessToken);
  ok(end.status === 200 && end.data.status === 'ENDED' && end.data.durationSec >= 1, `Call ended, duration ${end.data.durationSec}s`, end.data);
  ok(!!(await dSock.waitFor('call:status', (p) => p.id === call.data.id && p.status === 'ENDED')), 'Doctor notified: call ended');
  const done = (await api('GET', `/appointments/me/${booking.id}`, null, patient.accessToken)).data;
  ok(done.status === 'COMPLETED', 'Appointment marked COMPLETED after the call');

  // ── Call center ──
  const admin = (await api('POST', '/auth/admin/login', { email: 'agent@demo.local', password: 'Admin@12345' })).data;
  const aSock = listen(admin.accessToken);
  await aSock.ready;
  const quote = await api('GET', '/call-requests/quote', null, patient.accessToken);
  ok(quote.status === 200 && quote.data.total > 0, `Instant call fee: ৳${quote.data.serviceFee} + ৳${quote.data.platformFee} = ৳${quote.data.total}`);
  const cr = await api('POST', '/call-requests', { media: 'AUDIO', reason: 'Fever 2 days' }, patient.accessToken);
  ok(cr.status === 201 && cr.data.status === 'PAYMENT_PENDING', `Call request ${cr.data.code} created`, cr.data);
  const crPay = await api('POST', `/payments/call-requests/${cr.data.id}`, null, patient.accessToken);
  await api('POST', `/payments/${crPay.data.payment.id}/demo-confirm`, null, patient.accessToken);
  const queued = (await api('GET', `/call-requests/me/${cr.data.id}`, null, patient.accessToken)).data;
  ok(queued.status === 'QUEUED' && queued.queuePosition >= 1, `Paid → QUEUED (position ${queued.queuePosition})`, queued);
  ok(!!(await aSock.waitFor('queue:changed')), 'Agents notified: queue changed');

  const queue = (await api('GET', '/call-center/queue', null, admin.accessToken)).data;
  ok(queue.some((q) => q.id === cr.data.id), 'Call appears in the agent queue');
  const patientTriesQueue = await api('GET', '/call-center/queue', null, patient.accessToken);
  ok(patientTriesQueue.status === 403, 'Patients cannot see the call-center queue');

  const take = await api('POST', `/call-center/${cr.data.id}/accept`, null, admin.accessToken);
  ok(take.status === 200 && take.data.status === 'CONNECTED', 'Agent accepts → CONNECTED', take.data);
  ok(!!(await pSock.waitFor('callrequest:status', (p) => p.id === cr.data.id && p.status === 'CONNECTED')), 'Patient notified: agent connected (joins call)');
  const agentTok = await api('GET', `/calls/token?channel=${cr.data.channelName}`, null, admin.accessToken);
  ok(agentTok.status === 200, 'Agent gets Agora token for the call');
  await api('PATCH', `/call-center/${cr.data.id}/notes`, { notes: 'Fever 2 days, no red flags. Transfer to medicine.' }, admin.accessToken);

  const avail = (await api('GET', '/call-center/doctors', null, admin.accessToken)).data;
  ok(avail.some((d) => d.id === doctorId), `${avail.length} doctor(s) available for transfer`);
  const tr = await api('POST', `/call-center/${cr.data.id}/transfer`, { doctorId }, admin.accessToken);
  ok(tr.status === 200 && tr.data.status === 'RINGING' && tr.data.channelName === cr.data.channelName, 'Transfer rings the doctor into the SAME channel', tr.data);
  ok(!!(await dSock.waitFor('call:incoming', (p) => p.id === tr.data.id)), 'Doctor receives the transferred call');
  await api('POST', `/consultations/${tr.data.id}/accept`, null, doctor.accessToken);
  const afterTransfer = (await api('GET', `/call-requests/me/${cr.data.id}`, null, patient.accessToken)).data;
  ok(afterTransfer.status === 'TRANSFERRED', 'Doctor accepted → TRANSFERRED');
  const docTok = await api('GET', `/calls/token?channel=${cr.data.channelName}`, null, doctor.accessToken);
  ok(docTok.status === 200, 'Doctor can join the call-center channel');

  const fin = await api('POST', `/call-center/${cr.data.id}/complete`, null, admin.accessToken);
  ok(fin.status === 200 && fin.data.status === 'COMPLETED' && fin.data.consultations.every((c) => c.status === 'ENDED'), 'Agent completes → call and doctor leg closed', fin.data);
  const hist = await api('GET', '/doctor/consultations', null, doctor.accessToken);
  ok(hist.data.total >= 2, `Doctor history has ${hist.data.total} calls`);

  const adminTok = (await api('POST', '/auth/admin/login', { email: 'admin@demo.local', password: 'Admin@12345' })).data.accessToken;
  const pays = await api('GET', '/admin/payments?limit=5', null, adminTok);
  ok(pays.status === 200 && pays.data.summary.successCount >= 2, `Admin sees payments: ${pays.data.summary.successCount} successful, ৳${pays.data.summary.collected} collected`);

  [pSock, dSock, aSock].forEach((s) => s.socket.close());
  console.log(process.exitCode ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
})();
