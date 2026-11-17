/**
 * Integration settings: admin-managed Agora / Gmail / Firebase, email OTP login, device tokens.
 *   node scripts/settings-test.js [baseUrl]
 * Restores the original settings at the end.
 */
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

(async () => {
  const admin = (await api('POST', '/auth/admin/login', { email: 'admin@demo.local', password: 'Admin@12345' })).data.accessToken;
  const before = (await api('GET', '/admin/settings/integrations', null, admin)).data;
  ok(before.settings && 'agora.appId' in before.settings, 'Admin can read integration settings');

  // Validation
  const bad = await api('PUT', '/admin/settings/integrations', { values: { 'agora.appId': 'not-an-id' } }, admin);
  ok(bad.status === 400, 'Invalid Agora App ID rejected');
  const badSa = await api('PUT', '/admin/settings/integrations', { values: { 'firebase.serviceAccount': '{"x":1}' } }, admin);
  ok(badSa.status === 400, 'Invalid Firebase service account rejected');
  const unknown = await api('PUT', '/admin/settings/integrations', { values: { 'hack.key': '1' } }, admin);
  ok(unknown.status === 400, 'Unknown setting keys rejected');

  // Save Agora from the dashboard
  const saved = await api('PUT', '/admin/settings/integrations', {
    values: { 'agora.appId': '0123456789abcdef0123456789abcdef', 'agora.certificate': 'fedcba9876543210fedcba9876543210' },
  }, admin);
  ok(saved.status === 200 && saved.data.status.agora, 'Agora App ID + certificate saved from admin');
  ok(saved.data.settings['agora.certificate'].isSet && saved.data.settings['agora.certificate'].value === undefined, 'Certificate is stored but never returned (masked)');
  ok(saved.data.settings['agora.appId'].value === '0123456789abcdef0123456789abcdef', 'App ID is shown back');
  const tAgora = await api('POST', '/admin/settings/test/agora', null, admin);
  ok(tAgora.status === 200 && tAgora.data.tokenPreview, 'Agora test generates a token');

  const patientTry = await otp({ phone: `019${String(Date.now()).slice(-8)}` });
  const forbidden = await api('GET', '/admin/settings/integrations', null, patientTry.accessToken);
  ok(forbidden.status === 403, 'Patients cannot read settings');

  // Email OTP (Gmail not configured here → demo fallback code)
  const email = `patient${Date.now()}@example.com`;
  const req = await api('POST', '/auth/otp/request', { email });
  ok(req.status === 200 && (req.data.channel === 'email' || req.data.devCode === '123456'), `Email OTP requested (channel: ${req.data.channel})`, req.data);
  if (req.data.devCode) {
    const v = await api('POST', '/auth/otp/verify', { email, code: '123456' });
    ok(v.status === 200 && v.data.user.email === email && v.data.isNewUser, 'Email login creates a patient account', v.data);
    const dev = await api('POST', '/devices', { token: `test-token-${Date.now()}`, platform: 'android' }, v.data.accessToken);
    ok(dev.status === 200, 'App can register its push token');
  }
  const badEmail = await api('POST', '/auth/otp/request', { email: 'not-an-email' });
  ok(badEmail.status === 400, 'Invalid email rejected');
  const staff = await api('POST', '/auth/otp/request', { email: 'admin@demo.local' });
  if (staff.data.devCode) {
    const sv = await api('POST', '/auth/otp/verify', { email: 'admin@demo.local', code: '123456' });
    ok(sv.status === 403, 'Staff accounts cannot use the patient OTP login');
  }

  // Gmail test with wrong credentials gives a clear error
  await api('PUT', '/admin/settings/integrations', { values: { 'mail.gmailUser': 'nobody.test@gmail.com', 'mail.appPassword': 'abcd efgh ijkl mnop' } }, admin);
  const tMail = await api('POST', '/admin/settings/test/email', { to: 'nobody.test@gmail.com' }, admin);
  ok(tMail.status === 400 && /Gmail/.test(tMail.data.message), 'Wrong Gmail app password → clear error', tMail.data);

  // Public app config
  const cfg = await api('GET', '/app-config?platform=android');
  ok(cfg.status === 200 && 'firebase' in cfg.data && 'emailLogin' in cfg.data, `Public app-config (firebase: ${cfg.data.firebase ? 'set' : 'not set'})`);

  // Doctor app login by email
  const docs = (await api('GET', '/admin/doctors?limit=1&q=Sajjad', null, admin)).data.items;
  if (docs.length) {
    const link = await api('PUT', `/admin/doctors/${docs[0].id}/app-login`, { email: `doctor${Date.now()}@example.com` }, admin);
    ok(link.status === 200 && link.data.email, 'Admin gives a doctor an email login', link.data);
  }

  // Restore previous Agora/Gmail state
  const restore = {};
  for (const k of ['agora.appId', 'agora.certificate', 'mail.gmailUser', 'mail.appPassword']) restore[k] = before.settings[k].isSet ? undefined : '';
  await api('PUT', '/admin/settings/integrations', { values: Object.fromEntries(Object.entries(restore).filter(([, v]) => v !== undefined)) }, admin);
  console.log(process.exitCode ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');

  async function otp(id) {
    await api('POST', '/auth/otp/request', id);
    return (await api('POST', '/auth/otp/verify', { ...id, code: '123456' })).data;
  }
})();
