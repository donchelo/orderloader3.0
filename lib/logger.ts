type Level = "DEBUG" | "INFO" | "WARN" | "ERROR";

const LEVEL_VALUES: Record<Level, number> = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
const MIN_LEVEL =
  LEVEL_VALUES[(process.env.LOG_LEVEL?.toUpperCase() as Level) ?? "INFO"] ?? 20;

function ts(): string {
  return new Date().toISOString().slice(0, 23).replace("T", " ");
}

type LogMethod = {
  (msg: string): void;
  (fields: Record<string, unknown>, msg: string): void;
};

function makeMethod(level: Level, component: string): LogMethod {
  const value = LEVEL_VALUES[level];
  return function (fieldsOrMsg: Record<string, unknown> | string, msg?: string) {
    if (value < MIN_LEVEL) return;
    let message: string;
    if (typeof fieldsOrMsg === "string") {
      message = fieldsOrMsg;
    } else {
      message = msg ?? "";
      const err = fieldsOrMsg.err;
      if (err instanceof Error && err.message) message += `: ${err.message}`;
    }
    process.stdout.write(`${ts()} ${level.padEnd(5)} [${component}] ${message}\n`);
  } as LogMethod;
}

class Logger {
  readonly debug: LogMethod;
  readonly info:  LogMethod;
  readonly warn:  LogMethod;
  readonly error: LogMethod;

  constructor(private readonly name: string) {
    this.debug = makeMethod("DEBUG", name);
    this.info  = makeMethod("INFO",  name);
    this.warn  = makeMethod("WARN",  name);
    this.error = makeMethod("ERROR", name);
  }

  child(bindings: Record<string, unknown>): Logger {
    return new Logger((bindings.component as string) ?? this.name);
  }
}

export function getLogger(component: string): Logger {
  return new Logger(component);
}
