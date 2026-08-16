/**
 * The slice of Homebridge's Logger we use.
 *
 * Declared locally so adapters and the catalog stay testable without pulling
 * the Homebridge runtime into unit tests.
 */
export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Prefixes every line, so multi source logs say which source they came from. */
export function prefixed(log: Logger, prefix: string): Logger {
  return {
    debug: (message) => log.debug(`[${prefix}] ${message}`),
    info: (message) => log.info(`[${prefix}] ${message}`),
    warn: (message) => log.warn(`[${prefix}] ${message}`),
    error: (message) => log.error(`[${prefix}] ${message}`),
  };
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
