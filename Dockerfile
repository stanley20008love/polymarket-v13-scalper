FROM node:20-slim

WORKDIR /app

COPY polymarket-engine/package.json polymarket-engine/package-lock.json* ./
RUN npm install --production

COPY polymarket-engine/ .
RUN npx tsc || true
RUN mkdir -p public

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "dist/main.js"]
