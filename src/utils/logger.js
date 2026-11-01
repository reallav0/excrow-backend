import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logDir = path.join(__dirname, "../../logs");

/**
 * Logging switches.
 *
 * Writes are asynchronous and stream-based, so logging never blocks the event
 * loop. For load testing / benchmarking turn disk logging off completely:
 *   LOG_TO_FILE=false LOG_TO_CONSOLE=false
 */
const LOG_TO_FILE = process.env.LOG_TO_FILE !== "false";
const LOG_TO_CONSOLE = process.env.LOG_TO_CONSOLE !== "false";

const streams = new Map();

/**
 * Lazily open an append stream per log file.
 * Writes are buffered by the stream, so a slow disk degrades logging instead of
 * stalling request handling.
 */
function getStream(filename) {
  if (!LOG_TO_FILE) return null;

  const existing = streams.get(filename);
  if (existing) return existing;

  try {
    fs.mkdirSync(logDir, { recursive: true });
    const stream = fs.createWriteStream(path.join(logDir, filename), { flags: "a" });
    // Logging must never take the process down.
    stream.on("error", () => {
      streams.delete(filename);
    });
    streams.set(filename, stream);
    return stream;
  } catch {
    return null;
  }
}

function write(filename, line) {
  const stream = getStream(filename);
  if (!stream) return;
  stream.write(line + "\n");
}

const getTimestamp = () => {
  return new Date().toISOString();
};

export const logger = {
  info: (message, data = null) => {
    const timestamp = getTimestamp();
    const logMessage = data
      ? `[${timestamp}] INFO: ${message} | ${JSON.stringify(data)}`
      : `[${timestamp}] INFO: ${message}`;
    if (LOG_TO_CONSOLE) console.log(logMessage);
    write("app.log", logMessage);
  },

  error: (message, error = null) => {
    const timestamp = getTimestamp();
    const logMessage = error
      ? `[${timestamp}] ERROR: ${message} | ${error.message || JSON.stringify(error)}`
      : `[${timestamp}] ERROR: ${message}`;
    if (LOG_TO_CONSOLE) console.error(logMessage);
    write("error.log", logMessage);
  },

  warn: (message, data = null) => {
    const timestamp = getTimestamp();
    const logMessage = data
      ? `[${timestamp}] WARN: ${message} | ${JSON.stringify(data)}`
      : `[${timestamp}] WARN: ${message}`;
    if (LOG_TO_CONSOLE) console.warn(logMessage);
    write("app.log", logMessage);
  },

  api: (method, endpoint, statusCode, data = null) => {
    const timestamp = getTimestamp();
    const logMessage = `[${timestamp}] API | ${method} ${endpoint} | Status: ${statusCode}${
      data ? " | " + JSON.stringify(data) : ""
    }`;
    if (LOG_TO_CONSOLE) console.log(logMessage);
    write("api.log", logMessage);
  },

  /**
   * Flush and close all log streams (used on graceful shutdown).
   */
  close: () => {
    for (const stream of streams.values()) {
      try {
        stream.end();
      } catch {
        // ignore
      }
    }
    streams.clear();
  },
};

export default logger;
