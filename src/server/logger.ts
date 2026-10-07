import pino from 'pino';

const g = globalThis as unknown as { __logger?: pino.Logger };

export const logger: pino.Logger =
  g.__logger ??
  pino({
    level: process.env.LOG_LEVEL ?? 'info',
    base: { service: process.env.SERVICE_NAME ?? 'leads-crm-web' },
    redact: {
      paths: ['password', '*.password', 'token', '*.token', 'secret', '*.secret', 'req.headers.cookie', 'req.headers.authorization'],
      censor: '[redacted]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
if (process.env.NODE_ENV !== 'production') g.__logger = logger;
