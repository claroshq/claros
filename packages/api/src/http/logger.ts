/**
 * Minimal structured logger for the HTTP layer.
 *
 * Writes one JSON object per line (level, time, msg, extra fields), close to
 * the log lines v0.6 produced, so existing log pipelines keep working.
 */
export interface AppLogger {
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

const LEVELS = { debug: 20, info: 30, warn: 40, error: 50 } as const;
type Level = keyof typeof LEVELS;

/** `false` silences, `{ level }` configures, an object with log methods is used as is. */
export type LoggerOption = false | true | { level?: string } | AppLogger | undefined;

const silent: AppLogger = { debug() {}, info() {}, warn() {}, error() {} };

function jsonLogger(minLevel: Level): AppLogger {
  const write = (level: Level) => (obj: unknown, msg?: string) => {
    if (LEVELS[level] < LEVELS[minLevel]) return;
    const fields =
      typeof obj === "string"
        ? { msg: obj }
        : obj instanceof Error
          ? { err: { type: obj.name, message: obj.message, stack: obj.stack }, msg: msg ?? obj.message }
          : { ...(obj as Record<string, unknown>), ...(msg !== undefined ? { msg } : {}) };
    const line = JSON.stringify({ level: LEVELS[level], time: Date.now(), ...fields });
    if (LEVELS[level] >= LEVELS.warn) process.stderr.write(line + "\n");
    else process.stdout.write(line + "\n");
  };
  return { debug: write("debug"), info: write("info"), warn: write("warn"), error: write("error") };
}

export function createLogger(option: LoggerOption): AppLogger {
  if (option === false) return silent;
  if (option && typeof (option as AppLogger).warn === "function") return option as AppLogger;
  const configured = option && typeof option === "object" && "level" in option ? option.level : undefined;
  const level = (configured ?? process.env.LOG_LEVEL ?? "info") as string;
  return jsonLogger((level in LEVELS ? level : "info") as Level);
}
