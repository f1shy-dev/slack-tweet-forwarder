FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod=false
COPY . .
RUN pnpm build && pnpm prune --prod && mkdir -p /app/data && chown -R node:node /app
USER node
VOLUME ["/app/data"]
CMD ["node", "dist/index.js"]
