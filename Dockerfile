# syntax=docker/dockerfile:1.7
# Multi-stage image used for both the web server and the background worker.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

FROM deps AS build
COPY . .
RUN npx prisma generate && npm run openapi:static && npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates postgresql-client && rm -rf /var/lib/apt/lists/* \
  && groupadd -r app && useradd -r -g app -d /app app
COPY --from=build --chown=app:app /app /app
USER app
EXPOSE 3000
# Web:    docker run … (default)      Worker: docker run … npm run worker:prod
CMD ["npm", "run", "start"]
