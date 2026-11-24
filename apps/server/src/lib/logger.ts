import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';

/** Paths never logged (credentials, cookies, secrets). */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  '*.password',
  '*.secret',
  '*.token',
  '*.clientSecret',
  '*.headerValue',
  '*.apiKey',
  '*.accessToken',
  '*.refreshToken',
  'config.masterKeys',
  'config.hashPepper',
];

export interface LoggerConfig {
  level: string;
  pretty: boolean;
  instanceId?: string;
}

export function loggerOptions(cfg: LoggerConfig): LoggerOptions {
  const opts: LoggerOptions = {
    level: cfg.level,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    base: cfg.instanceId ? { instance: cfg.instanceId } : {},
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  if (cfg.pretty) {
    opts.transport = { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname,instance' } };
  }
  return opts;
}

export function createLogger(cfg: LoggerConfig, destination?: DestinationStream): Logger {
  const opts = loggerOptions(cfg);
  if (destination) {
    delete opts.transport;
    return pino(opts, destination);
  }
  return pino(opts);
}

export type { Logger };
