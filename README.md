# markeetor.com

Secure, multi-tenant lead distribution and CRM platform.

- **Platform portal** (`/admin`): import, validate and de-duplicate leads; distribute them to client
  organizations (10 strategies, quotas, scheduling, rollback, automated rules); manage clients,
  users, roles and approvals; analytics, security center, tamper-evident audit log, automation.
- **Client workspace** (`/app`): tenant-isolated CRM — leads, pipeline (Kanban), tasks and calendar,
  communication and consent logging, team management, analytics, workspace settings.
  Contact details are masked by default; there is no lead export.

Stack: Next.js 16 · React 19 · TypeScript · Tailwind 4 · PostgreSQL 16 (Prisma, row-level security) ·
Redis + BullMQ · Vitest.

```bash
npm install
APP_DB_PASSWORD=... BACKUP_DB_PASSWORD=... npm run db:setup   # or: docker compose up -d postgres redis
cp .env.example .env && $EDITOR .env
npm run db:migrate && npm run db:seed
npm run dev        # web
npm run worker     # background jobs (separate terminal)
npm test           # 65 unit, integration and security tests
```

See **[DEVELOPMENT.md](DEVELOPMENT.md)** for architecture, the security model, demo accounts,
module status, verification performed, operations and known limitations.
API reference: `docs/openapi.json` (served at `/api/v1/openapi.json` to platform users).
