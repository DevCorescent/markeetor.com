/**
 * pm2 process definitions for markeetor.com.
 *
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *
 * Two processes, because the web server and the background worker are separate concerns:
 * the worker owns imports, distribution, email and the scheduled jobs, and the site stays
 * responsive while it churns. Running more than one worker is safe — jobs are claimed with
 * FOR UPDATE SKIP LOCKED — but one is enough to start.
 *
 * Environment comes from `.env` in this directory:
 *   - `next start` reads it itself (Next.js has built-in dotenv support).
 *   - the worker gets it via node's `--env-file`, since `src/worker/index.ts` runs under tsx.
 */
const path = require('node:path');

const cwd = __dirname;
const PORT = process.env.PORT || 3000;

module.exports = {
  apps: [
    {
      name: 'markeetor-web',
      cwd,
      script: path.join(cwd, 'node_modules/next/dist/bin/next'),
      args: `start -p ${PORT}`,
      interpreter: 'node',
      instances: 1,
      exec_mode: 'fork',
      env: { NODE_ENV: 'production' },
      max_memory_restart: '1G',
      // Next needs a moment to bind; don't thrash if the database is briefly unreachable.
      min_uptime: '20s',
      max_restarts: 10,
      restart_delay: 3000,
      out_file: path.join(cwd, '.logs/web.out.log'),
      error_file: path.join(cwd, '.logs/web.err.log'),
      merge_logs: true,
      time: true,
    },
    {
      name: 'markeetor-worker',
      cwd,
      script: path.join(cwd, 'node_modules/tsx/dist/cli.mjs'),
      args: 'src/worker/index.ts',
      interpreter: 'node',
      interpreter_args: '--env-file=.env',
      instances: 1,
      exec_mode: 'fork',
      env: { NODE_ENV: 'production', SERVICE_NAME: 'leads-crm-worker' },
      max_memory_restart: '1G',
      min_uptime: '20s',
      max_restarts: 10,
      restart_delay: 5000,
      // SIGTERM lets the worker drain in-flight jobs before exiting (see src/worker/index.ts).
      kill_timeout: 35000,
      out_file: path.join(cwd, '.logs/worker.out.log'),
      error_file: path.join(cwd, '.logs/worker.err.log'),
      merge_logs: true,
      time: true,
    },
  ],
};
