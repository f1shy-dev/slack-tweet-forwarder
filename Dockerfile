FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
ENV CONFIG_PATH=/app/data/classifier-config.json
ENV DEDUPE_PATH=/app/data/dedupe.json
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod=false
COPY . .
RUN pnpm build && pnpm prune --prod && mkdir -p /app/data && chown -R node:node /app
USER node
VOLUME ["/app/data"]
CMD ["node", "dist/index.js"]
