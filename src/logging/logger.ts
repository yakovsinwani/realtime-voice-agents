/**
 * Minimal structured logger seam. Pino/winston/console all adapt in one line;
 * the default is silent so the library never spams a host app's stdout.
 */

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  /** Derive a logger with bound context (e.g. callSid). */
  child?(context: Record<string, unknown>): Logger;
}

export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};

/** Console-backed logger, useful in examples and debugging. */
export function consoleLogger(context: Record<string, unknown> = {}): Logger {
  const prefix = Object.keys(context).length ? ` ${JSON.stringify(context)}` : '';
  return {
    debug: (msg, data) => console.debug(`[debug]${prefix} ${msg}`, data ?? ''),
    info: (msg, data) => console.info(`[info]${prefix} ${msg}`, data ?? ''),
    warn: (msg, data) => console.warn(`[warn]${prefix} ${msg}`, data ?? ''),
    error: (msg, data) => console.error(`[error]${prefix} ${msg}`, data ?? ''),
    child: (extra) => consoleLogger({ ...context, ...extra }),
  };
}

export function childLogger(logger: Logger, context: Record<string, unknown>): Logger {
  return logger.child ? logger.child(context) : logger;
}
