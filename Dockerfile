FROM node:24-alpine AS base
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY scripts ./scripts
COPY src ./src
COPY docs ./docs
COPY README.md .
COPY .env.example .

ENV NODE_ENV=production
ENV DATA_DIR=/data

VOLUME ["/data"]

EXPOSE 3001

CMD ["node", "scripts/codex-sync-runner.js", "daemon"]
