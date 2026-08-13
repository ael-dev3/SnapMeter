export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  write?: (line: string) => void;
  now?: () => number;
  secrets?: readonly string[];
  minimumLevel?: LogLevel;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SENSITIVE_KEY = /(?:authorization|cookie|password|secret|signature|token)/i;

export function createLogger(options: LoggerOptions = {}): Logger {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? Date.now;
  const secrets = (options.secrets ?? []).filter(Boolean);
  const threshold = LEVELS[options.minimumLevel ?? "info"];

  const emit = (level: LogLevel, event: string, fields: Record<string, unknown> = {}): void => {
    if (LEVELS[level] < threshold) return;
    const record = redact({ timestamp: new Date(now()).toISOString(), level, event, ...fields }, secrets);
    write(JSON.stringify(record));
  };

  return {
    debug: (event, fields) => emit("debug", event, fields),
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields)
  };
}

export function redact(value: unknown, secrets: readonly string[] = [], key = ""): unknown {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (value instanceof Error) {
    return { name: value.name, message: scrub(value.message, secrets), code: errorCode(value) };
  }
  if (typeof value === "string") return scrub(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redact(child, secrets, childKey)]));
  }
  return value;
}

function scrub(value: string, secrets: readonly string[]): string {
  let result = value;
  for (const secret of secrets) {
    if (secret.length > 0) result = result.split(secret).join("[REDACTED]");
  }
  return result;
}

function errorCode(error: Error): unknown {
  return "code" in error ? (error as Error & { code?: unknown }).code : undefined;
}
