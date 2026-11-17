/**
 * Load test for the hottest public endpoints (what the patient app calls on every screen).
 *   node scripts/loadtest.js [baseUrl] [connections] [seconds]
 * Start the API with THROTTLE_SKIP=true first, otherwise the per-IP rate limit
 * (correctly) blocks this single-IP test.
 */
const autocannon = require('autocannon');

const base = process.argv[2] || 'http://localhost:4000';
const connections = Number(process.argv[3] || 1000);
const duration = Number(process.argv[4] || 20);

const paths = [
  '/api/v1/doctors?limit=20',
  '/api/v1/doctors?divisionId=1&limit=20',
  '/api/v1/doctors?specialtyId=2&sort=fee_asc&limit=20',
  '/api/v1/doctors?type=ONLINE_VIDEO&limit=20',
  '/api/v1/specialties',
  '/api/v1/locations/divisions',
  '/api/v1/locations/tree',
];

console.log(`Load test: ${connections} concurrent connections for ${duration}s against ${base}`);
const instance = autocannon(
  {
    url: base,
    connections,
    duration,
    pipelining: 1,
    timeout: 10,
    requests: paths.map((path) => ({ method: 'GET', path })),
  },
  (err, r) => {
    if (err) throw err;
    const errors = r.errors + r.timeouts + (r.non2xx || 0);
    console.log('\n──────── RESULT ────────');
    console.log(`Requests:        ${r.requests.total.toLocaleString()} in ${duration}s`);
    console.log(`Throughput:      ${Math.round(r.requests.average).toLocaleString()} req/s (avg)`);
    console.log(`Latency avg:     ${r.latency.average.toFixed(1)} ms`);
    console.log(`Latency p50/p99: ${r.latency.p50} ms / ${r.latency.p99} ms`);
    console.log(`Errors/timeouts: ${errors} (non-2xx: ${r.non2xx || 0})`);
  },
);
autocannon.track(instance, { renderProgressBar: false, renderResultsTable: false });
