FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /usr/src/app

# Copy dependency manifests first for better layer caching.
COPY package*.json ./

# Install only production dependencies.
RUN npm ci --omit=dev

# Copy app source after dependencies are installed.
COPY src ./src

# Ensure runtime writable directory exists for logs.
RUN mkdir -p logs && chown -R node:node /usr/src/app

EXPOSE 3001
USER node
CMD ["node", "src/index.js"]
