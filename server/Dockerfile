FROM node:20-alpine
WORKDIR /app

# Server deps first for layer caching.
COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev

# App code: static frontend at /app, server at /app/server.
COPY . .

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server/index.js"]
