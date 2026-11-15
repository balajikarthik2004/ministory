import { pino } from 'pino';
import { env, isDevelopment } from '../config/env.js';
import { SERVICE_NAME } from '../config/constants.js';

/**
 * Structured JSON logs in every environment; pretty-printed only in local dev.
 * Redaction is not optional - a log line is a place secrets leak to disk and to
 * whatever aggregates them (CLAUDE.md §11).
 */
export const logger = pino({
  name: SERVICE_NAME,
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.body.password',
      'req.body.refreshToken',
      'req.body.firebaseIdToken',
      'res.headers["set-cookie"]',
    ],
    censor: '[redacted]',
  },
  ...(isDevelopment
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      }
    : {}),
});

export type Logger = typeof logger;
