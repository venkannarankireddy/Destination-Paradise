# ==============================================================================
# Destination Paradise — Production Dockerfile
# Multi-stage, unprivileged non-root execution on Node.js 24 Alpine LTS
# ==============================================================================

# Stage 1: Dependency Installation
FROM node:24-alpine AS dependencies

WORKDIR /usr/src/app

# Copy package manifests for reproducible dependency installation based on package-lock.json
COPY package.json package-lock.json ./

# Install production dependencies reproducibly without running arbitrary lifecycle scripts
RUN npm ci --omit=dev --ignore-scripts

# ------------------------------------------------------------------------------
# Stage 2: Production Runtime
# ------------------------------------------------------------------------------
FROM node:24-alpine AS runner

# Set production environment variables
ENV NODE_ENV=production \
    PORT=3000 \
    APP_TIMEZONE=Asia/Colombo

WORKDIR /app

# Ensure proper non-root file ownership for node user (UID 1000)
RUN chown -R node:node /app

# Copy installed production dependencies from builder stage
COPY --chown=node:node --from=dependencies /usr/src/app/node_modules ./node_modules

# Copy package manifests
COPY --chown=node:node package.json package-lock.json ./

# Copy runtime application source and templates
COPY --chown=node:node app.js ./
COPY --chown=node:node lib/ ./lib/
COPY --chown=node:node views/ ./views/
COPY --chown=node:node public/ ./public/
COPY --chown=node:node firestore.indexes.json ./

# Switch to unprivileged built-in node user
USER node

# Expose default HTTP port
EXPOSE 3000

# Exec form ensures Node.js runs as PID 1 to receive SIGTERM/SIGINT signals directly
CMD ["node", "app.js"]

