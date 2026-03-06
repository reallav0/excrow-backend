import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logDir = path.join(__dirname, "../../logs");

// Create logs directory if it doesn't exist
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const getTimestamp = () => {
  return new Date().toISOString();
};

const writeToFile = (filename, message) => {
  const logPath = path.join(logDir, filename);
  fs.appendFileSync(logPath, message + "\n");
};

export const logger = {
  info: (message, data = null) => {
    const timestamp = getTimestamp();
    const logMessage = data
      ? `[${timestamp}] INFO: ${message} | ${JSON.stringify(data)}`
      : `[${timestamp}] INFO: ${message}`;
    console.log(logMessage);
    writeToFile("app.log", logMessage);
  },

  error: (message, error = null) => {
    const timestamp = getTimestamp();
    const logMessage = error
      ? `[${timestamp}] ERROR: ${message} | ${error.message || JSON.stringify(error)}`
      : `[${timestamp}] ERROR: ${message}`;
    console.error(logMessage);
    writeToFile("error.log", logMessage);
  },

  warn: (message, data = null) => {
    const timestamp = getTimestamp();
    const logMessage = data
      ? `[${timestamp}] WARN: ${message} | ${JSON.stringify(data)}`
      : `[${timestamp}] WARN: ${message}`;
    console.warn(logMessage);
    writeToFile("app.log", logMessage);
  },

  api: (method, endpoint, statusCode, data = null) => {
    const timestamp = getTimestamp();
    const logMessage = `[${timestamp}] API | ${method} ${endpoint} | Status: ${statusCode}${
      data ? " | " + JSON.stringify(data) : ""
    }`;
    console.log(logMessage);
    writeToFile("api.log", logMessage);
  },
};

export default logger;
