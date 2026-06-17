export const logger = {
  info: (message: string, data?: unknown): void => {
    console.log(JSON.stringify({ level: "info", message, data, at: new Date().toISOString() }));
  },
  warn: (message: string, data?: unknown): void => {
    console.warn(JSON.stringify({ level: "warn", message, data, at: new Date().toISOString() }));
  },
  error: (message: string, data?: unknown): void => {
    console.error(JSON.stringify({ level: "error", message, data, at: new Date().toISOString() }));
  }
};
