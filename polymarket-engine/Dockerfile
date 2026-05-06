FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY . .
RUN npx tsc || true

EXPOSE 3000

CMD ["node", "dist/main.js"]
