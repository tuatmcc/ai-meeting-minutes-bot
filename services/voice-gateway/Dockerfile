FROM node:24-bookworm-slim

RUN corepack enable && corepack prepare pnpm@11.27.0 --activate

WORKDIR /app
COPY . .

RUN pnpm install --filter @ai-meeting-minutes/voice-gateway... --frozen-lockfile \
	&& mkdir -p services/voice-gateway/var/recordings \
	&& chown -R node:node services/voice-gateway/var

USER node

CMD ["pnpm", "--filter", "@ai-meeting-minutes/voice-gateway", "start"]
