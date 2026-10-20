FROM node:24-bookworm-slim

RUN corepack enable && corepack prepare pnpm@11.27.0 --activate

WORKDIR /app
COPY . .

RUN pnpm install --filter @ai-meeting-minutes/voice-gateway... --frozen-lockfile \
	&& mkdir -p apps/voice-gateway/var/recordings \
	&& chown -R node:node apps/voice-gateway/var

USER node

WORKDIR /app/apps/voice-gateway

CMD ["node", "--experimental-transform-types", "src/index.ts"]
