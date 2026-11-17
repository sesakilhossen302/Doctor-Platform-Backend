// PM2 cluster mode: runs one API process per CPU core so a single server
// uses all cores. Run with: npm run build && npx pm2-runtime ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'doctor-api',
      script: 'dist/main.js',
      instances: 'max',
      exec_mode: 'cluster',
      max_memory_restart: '700M',
      env: { NODE_ENV: 'production' },
    },
  ],
};
