/**
 * Runs the demo seed on startup only when RUN_SEED=true (e.g. once on Railway),
 * so the database never has to be exposed publicly to seed it.
 * The seed is idempotent; set SEED_ADMIN_PASSWORD to choose the staff password.
 */
if (process.env.RUN_SEED !== 'true') process.exit(0);
console.log('RUN_SEED=true → seeding demo data…');
require('../dist-seed/prisma/seed.js');
