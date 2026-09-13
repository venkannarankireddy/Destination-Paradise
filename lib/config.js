const fs = require("fs");
const path = require("path");

const INSECURE_SESSION_SECRETS = new Set([
  "keyboard cat",
  "dev-fallback-secret-destination-paradise",
  "change-me",
  "your_strong_session_secret_here",
  "secret",
  "12345678",
]);

/**
 * Validates startup configuration for Destination Paradise.
 * Fails fast in production on missing or insecure critical configuration.
 *
 * @param {object} env - Environment object (defaults to process.env)
 * @param {boolean} exitOnError - Whether to call process.exit(1) on fatal validation failure
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
function validateConfig(env = process.env, exitOnError = false) {
  const isProd = env.NODE_ENV === "production";
  const errors = [];
  const warnings = [];

  // 1. Validate PORT
  const portVal = env.PORT ? parseInt(env.PORT, 10) : 3000;
  if (isNaN(portVal) || portVal < 1 || portVal > 65535) {
    errors.push("PORT must be a valid integer between 1 and 65535.");
  }

  // 2. Validate APP_TIMEZONE
  const timezone = env.APP_TIMEZONE || "Asia/Colombo";
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
  } catch (e) {
    errors.push(`APP_TIMEZONE '${timezone}' is not a valid IANA timezone identifier.`);
  }

  // 3. Validate SESSION_SECRET
  const sessionSecret = env.SESSION_SECRET;
  if (isProd) {
    if (!sessionSecret) {
      errors.push("SESSION_SECRET is required in production mode.");
    } else if (INSECURE_SESSION_SECRETS.has(sessionSecret.trim().toLowerCase())) {
      errors.push("SESSION_SECRET must not use insecure default placeholders in production mode.");
    } else if (sessionSecret.length < 32) {
      errors.push("SESSION_SECRET must be at least 32 characters long in production mode.");
    }
  } else {
    if (!sessionSecret) {
      warnings.push("SESSION_SECRET is not set in .env. Using fallback development secret.");
    } else if (sessionSecret.length < 16) {
      warnings.push("SESSION_SECRET is short (<16 chars). A stronger secret is recommended.");
    }
  }

  // 4. Validate FIREBASE_API_KEY
  const apiKey = env.FIREBASE_API_KEY;
  if (isProd) {
    if (!apiKey || apiKey.trim() === "" || apiKey === "your_firebase_web_api_key_here") {
      errors.push("FIREBASE_API_KEY is required in production mode for authentication services.");
    }
  } else {
    if (!apiKey || apiKey.trim() === "" || apiKey === "your_firebase_web_api_key_here") {
      warnings.push("FIREBASE_API_KEY is not defined in .env. Authentication requests will fail.");
    }
  }

  // 5. Validate Firebase Admin SDK Credentials
  const localKeyPath = path.join(__dirname, "..", "key.json");
  const hasEnvKey = !!(env.FIREBASE_SERVICE_ACCOUNT_KEY && env.FIREBASE_SERVICE_ACCOUNT_KEY.trim());
  const hasGoogleCreds = !!(env.GOOGLE_APPLICATION_CREDENTIALS && env.GOOGLE_APPLICATION_CREDENTIALS.trim());
  const hasLocalFile = fs.existsSync(localKeyPath);

  if (!hasEnvKey && !hasGoogleCreds && !hasLocalFile) {
    errors.push("No Firebase Admin credentials found. Provide key.json locally or set FIREBASE_SERVICE_ACCOUNT_KEY / GOOGLE_APPLICATION_CREDENTIALS.");
  }

  // 6. Validate SHUTDOWN_TIMEOUT_MS
  if (env.SHUTDOWN_TIMEOUT_MS) {
    const timeout = parseInt(env.SHUTDOWN_TIMEOUT_MS, 10);
    if (isNaN(timeout) || timeout <= 0) {
      warnings.push("SHUTDOWN_TIMEOUT_MS must be a positive integer. Using default 10000ms.");
    }
  }

  // 7. Validate TRUST_PROXY
  if (env.TRUST_PROXY !== undefined && env.TRUST_PROXY !== "") {
    const proxyResult = parseTrustProxy(env.TRUST_PROXY);
    if (!proxyResult.valid) {
      errors.push(proxyResult.error);
    }
  }

  const valid = errors.length === 0;

  if (!valid && exitOnError) {
    console.error("❌ STARTUP CONFIGURATION ERROR: The application cannot start due to missing or invalid configuration:");
    errors.forEach((err) => console.error(`   - ${err}`));
    console.error("Please verify your environment configuration and restart the application.\n");
    process.exit(1);
  }

  return { valid, errors, warnings };
}

/**
 * Parses and validates the TRUST_PROXY configuration value.
 *
 * Supported values:
 * - integer >= 0 (e.g. "1" for 1 trusted proxy hop)
 * - boolean ("true", "false")
 * - subnet / IP / CIDR list (e.g. "loopback, 10.0.0.0/8")
 *
 * @param {string|number|boolean|undefined} val
 * @returns {{ valid: boolean, parsedValue: any, error?: string }}
 */
function parseTrustProxy(val) {
  if (val === undefined || val === null || val === "") {
    return { valid: true, parsedValue: false };
  }

  if (typeof val === "boolean") {
    return { valid: true, parsedValue: val };
  }

  if (typeof val === "number") {
    if (Number.isInteger(val) && val >= 0) {
      return { valid: true, parsedValue: val };
    }
    return { valid: false, error: "TRUST_PROXY number must be a non-negative integer." };
  }

  const trimmed = String(val).trim();

  if (trimmed.toLowerCase() === "true") {
    return { valid: true, parsedValue: true };
  }
  if (trimmed.toLowerCase() === "false") {
    return { valid: true, parsedValue: false };
  }

  if (/^-\d+$/.test(trimmed)) {
    return { valid: false, error: "TRUST_PROXY hop count cannot be negative." };
  }

  if (/^\d+$/.test(trimmed)) {
    const num = parseInt(trimmed, 10);
    if (num >= 0 && num <= 100) {
      return { valid: true, parsedValue: num };
    }
    return { valid: false, error: "TRUST_PROXY hop count must be between 0 and 100." };
  }

  // Comma-separated list of valid keywords, IPs, or CIDRs
  // Safe pattern: alphanumeric, dots, colons, slashes, commas, whitespace, hyphens
  if (/^[a-zA-Z0-9.:/,\s_-]+$/.test(trimmed)) {
    return { valid: true, parsedValue: trimmed };
  }

  return { valid: false, error: `Invalid TRUST_PROXY configuration: '${trimmed}'. Must be a hop count (e.g. '1'), boolean, or valid IP/subnet list.` };
}

module.exports = {
  validateConfig,
  parseTrustProxy,
};
