/**
 * Structured Logging Module for Destination Paradise
 * Features:
 * - JSON log format in production; human-readable in development
 * - Deep redaction of sensitive credentials, keys, passwords, and tokens
 * - Request correlation tracking
 * - HTTP request duration tracking middleware
 */

const SENSITIVE_KEYS = new Set([
  "password",
  "newpassword",
  "currentpassword",
  "confirmpassword",
  "sessionsecret",
  "csrf_secret",
  "csrftoken",
  "_csrf",
  "private_key",
  "privatekey",
  "firebase_api_key",
  "apikey",
  "token",
  "authorization",
  "secret",
  "credential",
  "credentials",
]);

/**
 * Recursively redacts sensitive keys from objects and arrays.
 *
 * @param {any} data - Object or value to sanitize
 * @param {number} depth - Recursion depth limit to prevent circular structure issues
 * @returns {any} Sanitized copy
 */
function sanitizeLogData(data, depth = 0) {
  if (depth > 5 || data === null || typeof data !== "object") {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map((item) => sanitizeLogData(item, depth + 1));
  }

  if (data instanceof Error) {
    return {
      name: data.name,
      message: data.message,
      code: data.code,
      stack: process.env.NODE_ENV === "production" ? undefined : data.stack,
    };
  }

  const clean = {};
  for (const [key, val] of Object.entries(data)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_KEYS.has(lowerKey)) {
      clean[key] = "[REDACTED]";
    } else if (typeof val === "object" && val !== null) {
      clean[key] = sanitizeLogData(val, depth + 1);
    } else {
      clean[key] = val;
    }
  }
  return clean;
}

const isProd = process.env.NODE_ENV === "production";

function log(level, message, meta = {}) {
  const timestamp = new Date().toISOString();
  const sanitizedMeta = sanitizeLogData(meta);
  const requestId = meta.requestId || sanitizedMeta.requestId || undefined;

  if (isProd) {
    const entry = {
      timestamp,
      level,
      message,
      ...(requestId ? { requestId } : {}),
      ...sanitizedMeta,
    };
    const jsonStr = JSON.stringify(entry);
    if (level === "error") {
      process.stderr.write(jsonStr + "\n");
    } else {
      process.stdout.write(jsonStr + "\n");
    }
  } else {
    const reqTag = requestId ? ` [${requestId.slice(0, 8)}]` : "";
    const metaStr = Object.keys(sanitizedMeta).length > 0 ? " " + JSON.stringify(sanitizedMeta) : "";
    const line = `[${timestamp}] [${level.toUpperCase()}]${reqTag} ${message}${metaStr}`;
    if (level === "error") {
      console.error(line);
    } else if (level === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }
  }
}

const logger = {
  info: (msg, meta) => log("info", msg, meta),
  warn: (msg, meta) => log("warn", msg, meta),
  error: (msg, meta) => log("error", msg, meta),
  debug: (msg, meta) => {
    if (process.env.LOG_LEVEL === "debug" || !isProd) {
      log("debug", msg, meta);
    }
  },
  sanitizeLogData,
};

/**
 * Express middleware for logging HTTP requests with duration and correlation ID.
 */
function requestLogger(req, res, next) {
  const start = process.hrtime.bigint();

  res.on("finish", () => {
    // Avoid spamming logs with static assets if desired, but keep API / HTML routes logged
    const durationNs = process.hrtime.bigint() - start;
    const durationMs = Number(durationNs) / 1e6;

    const meta = {
      requestId: req.id,
      method: req.method,
      path: req.originalUrl || req.url,
      status: res.statusCode,
      durationMs: parseFloat(durationMs.toFixed(2)),
    };

    if (res.statusCode >= 500) {
      logger.error("HTTP Request Error", meta);
    } else if (res.statusCode >= 400) {
      logger.warn("HTTP Client Warning", meta);
    } else {
      logger.info("HTTP Request", meta);
    }
  });

  next();
}

module.exports = {
  logger,
  requestLogger,
  sanitizeLogData,
};

