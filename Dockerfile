FROM node:20-slim

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm install --production

# Copy source and public files
COPY . .

# Build TypeScript
RUN npx tsc || true

# Ensure public directory exists
RUN mkdir -p public

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "dist/main.js"]
