const crypto = require("crypto");

// Strictly allow alphanumeric, hyphens, and underscores up to 128 chars
const VALID_REQUEST_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;

/**
 * Express middleware for request correlation IDs.
 * Inspects 'X-Request-ID' header, validates it, or generates a secure UUID v4.
 * Attaches the ID to req.id, res.locals.requestId, and the X-Request-ID response header.
 */
function requestIdMiddleware(req, res, next) {
  const incomingId = req.headers["x-request-id"];

  let requestId;
  if (typeof incomingId === "string" && VALID_REQUEST_ID_REGEX.test(incomingId.trim())) {
    requestId = incomingId.trim();
  } else {
    requestId = crypto.randomUUID();
  }

  req.id = requestId;
  res.locals.requestId = requestId;
  res.setHeader("X-Request-ID", requestId);

  next();
}

module.exports = {
  requestIdMiddleware,
  VALID_REQUEST_ID_REGEX,
};

