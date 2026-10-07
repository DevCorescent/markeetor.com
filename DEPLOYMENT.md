# Deploying markeetor.com to AWS EC2

Ubuntu 24.04 + pm2 + nginx + certbot, with Postgres on Neon.

There is **no Redis**: background jobs, rate limits and the TTL key store all live in Postgres
(`jobs`, `job_schedules`, `rate_limit_counters`, `kv_store`). The only external service is the
database.

---

## 0. Instance

| | |
|---|---|
| AMI | Ubuntu Server 24.04 LTS |
| Type | **t3.small minimum** (2 GB). `next build` runs out of memory on t3.micro. |
| Disk | 20 GB gp3 |
| Region | Match your Neon region (**us-east-2** for this project) to keep query latency low |

Security group — inbound:

| Port | Source | Why |
|---|---|---|
| 22 | your IP only | SSH |
| 80 | 0.0.0.0/0 | HTTP, and certbot's challenge |
| 443 | 0.0.0.0/0 | HTTPS |

**Do not open 3000.** nginx reaches the app on `127.0.0.1:3000`; exposing it publicly bypasses
TLS and the proxy headers the app depends on.

## 1. DNS

Point the domain at the instance's **Elastic IP** (allocate one, so the address survives a stop/start):

```
A    markeetor.com       -> <elastic-ip>
A    www.markeetor.com   -> <elastic-ip>
```

Wait for propagation before running certbot — it validates over HTTP:

```bash
dig +short markeetor.com
```

## 2. Base packages

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git nginx ca-certificates gnupg postgresql-client

# Node.js 22 (the project requires >= 20.9)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v && npm -v

sudo npm install -g pm2
```

Add swap. A 2 GB instance can still OOM during `next build`:

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h
```

## 3. Get the code

```bash
sudo mkdir -p /var/www && sudo chown -R $USER:$USER /var/www
cd /var/www
git clone https://github.com/DevCorescent/markeetor.com.git markeetor
cd markeetor
```

Private repo → use a deploy key (read-only, scoped to this repo) rather than your password:

```bash
ssh-keygen -t ed25519 -C "markeetor-ec2" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
# Add that key at: GitHub repo -> Settings -> Deploy keys -> Add deploy key (no write access)
git remote set-url origin git@github.com:DevCorescent/markeetor.com.git
```

## 4. Environment

```bash
cp .env.example .env
nano .env
```

Generate **fresh** secrets on the server — never reuse the development values:

```bash
echo "ENCRYPTION_KEY=$(openssl rand -base64 32)"
echo "SESSION_SECRET=$(openssl rand -base64 32)"
```

Minimum working `.env`:

```ini
NODE_ENV=production
APP_URL=https://markeetor.com

DATABASE_URL=postgresql://USER:PASSWORD@ep-....us-east-2.aws.neon.tech/neondb?sslmode=require

ENCRYPTION_KEY=<openssl rand -base64 32>
SESSION_SECRET=<openssl rand -base64 32>

STORAGE_DIR=/var/www/markeetor/storage
MAX_UPLOAD_MB=25
LOG_LEVEL=info

# REQUIRED behind nginx. The app then trusts the left-most X-Forwarded-For hop as the
# client IP. Only safe because deploy/nginx/markeetor.com.conf OVERWRITES that header
# with $remote_addr — see the comment in that file before changing either one.
TRUST_PROXY=true

MAIL_FROM="markeetor.com <no-reply@markeetor.com>"
# Until SMTP_URL is set, every message is written to Settings -> Outbox and NOT delivered.
# That includes invitations and password resets.
# SMTP_URL=smtp://user:pass@smtp.example.com:587
```

Lock it down — it holds the database password and the key that encrypts MFA secrets:

```bash
chmod 600 .env
```

`APP_URL` must be the real `https://` domain. The session cookie uses the `__Host-` prefix,
which browsers only accept over HTTPS, so sign-in silently fails on plain HTTP.

## 5. Build

```bash
npm ci
npx prisma generate
npm run openapi:static
npm run build
```

## 6. Database

```bash
npm run db:migrate          # prisma migrate deploy
npm run db:bootstrap        # permission catalog + system roles  (REQUIRED)
```

`db:bootstrap` is not optional. Without the `permissions` and `roles` rows every authenticated
endpoint returns 403, because the API is deny-by-default and resolves permissions from those
tables. `prisma/seed.ts` cannot do this job — it refuses to run when `NODE_ENV=production`.

Create the first administrator (nothing else can — inviting a user needs an existing user):

```bash
ADMIN_EMAIL='you@yourdomain.com' \
ADMIN_PASSWORD='<a strong password>' \
npm run db:bootstrap
```

Optionally seed one demo account per role, to exercise the portals:

```bash
ADMIN_EMAIL='you@yourdomain.com' ADMIN_PASSWORD='...' npm run db:seed:accounts
```

Platform users must enroll two-factor authentication on first sign-in. To check the policy:

```sql
SELECT value FROM platform_settings WHERE key = 'security.policy';
```

## 7. Start with pm2

```bash
mkdir -p .logs storage && chmod 700 storage

pm2 start ecosystem.config.cjs
pm2 save
pm2 startup systemd     # prints a command — run the sudo line it gives you

pm2 status
pm2 logs markeetor-web --lines 50
pm2 logs markeetor-worker --lines 50
```

Two processes start: `markeetor-web` (port 3000) and `markeetor-worker`. The worker registers
13 repeatable schedules on boot and logs `worker started`.

Confirm locally before touching nginx:

```bash
curl -I http://127.0.0.1:3000/login       # expect 200
```

## 8. nginx

```bash
sudo cp deploy/nginx/markeetor.com.conf /etc/nginx/sites-available/markeetor.com
sudo ln -s /etc/nginx/sites-available/markeetor.com /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx

curl -I http://markeetor.com/login        # expect 200 over plain HTTP
```

## 9. TLS with certbot

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d markeetor.com -d www.markeetor.com \
  --agree-tos -m you@yourdomain.com --redirect
```

`--redirect` adds the 80 -> 443 redirect. Certbot installs a systemd timer for renewal; verify it:

```bash
sudo systemctl list-timers | grep certbot
sudo certbot renew --dry-run
```

Check the result:

```bash
curl -I https://markeetor.com/login
curl -sI https://markeetor.com/login | grep -i strict-transport-security
```

## 10. Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw --force enable
sudo ufw status
```

---

## Redeploying

```bash
cd /var/www/markeetor
git pull
npm ci
npx prisma generate
npm run db:migrate
npm run build
pm2 reload ecosystem.config.cjs
pm2 status
```

`pm2 reload` restarts the web process and sends the worker SIGTERM, which lets it finish
in-flight jobs (up to 30s) instead of abandoning them mid-run.

## Operating it

```bash
pm2 status
pm2 logs markeetor-worker --lines 100
pm2 monit
pm2 describe markeetor-worker
```

Queue depth, failed jobs and worker liveness are on **Admin → System** in the UI, which reads
the same `jobs` table. The worker is considered healthy when its heartbeat is under 90 seconds
old; if `Admin → System` shows no heartbeat, the worker process is down.

Failed jobs are retried with exponential backoff, then dead-lettered to a platform alert. You
can requeue them from that page.

Logs: `.logs/web.*.log`, `.logs/worker.*.log`, `/var/log/nginx/markeetor.*.log`.

## Backups

Neon's own branching and point-in-time restore are the primary recovery path — prefer them.
`scripts/backup.sh` needs a role with `BYPASSRLS` to dump the force-RLS tables, which on Neon
means the project owner role, and `pg_dump` 18 to match the server version.

## Things that commonly go wrong

| Symptom | Cause |
|---|---|
| Every API call returns 403 after a clean deploy | `npm run db:bootstrap` was not run — no roles exist |
| Sign-in appears to succeed then bounces back to `/login` | `APP_URL` is not `https://`, so the `__Host-` cookie is rejected |
| CSV import fails with 413 | `client_max_body_size` too low in nginx (the bundled config sets 30m) |
| Rate limits trivially bypassed | nginx using `$proxy_add_x_forwarded_for` while `TRUST_PROXY=true` — see §4 |
| Invitations and password resets never arrive | `SMTP_URL` unset; messages sit in Settings → Outbox |
| Imports stay "queued" forever | worker process is down — `pm2 status`, then `pm2 logs markeetor-worker` |
| `next build` killed | not enough memory — add the swap file from §2, or use a larger instance |
