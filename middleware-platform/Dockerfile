# Cloud Run — Somo Trading Agent
FROM node:20-bookworm-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV TRADING_MODE=paper
ENV TRADING_DB_PATH=/var/data/trading.sqlite
EXPOSE 8080

CMD ["node", "server.js"]
