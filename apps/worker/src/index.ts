import type { WorkerEnv } from './env.js';
import { handleSessionApi } from './api/session-api.js';
import { handleDiscordInteraction } from './api/discord-interactions.js';

export { VoiceChannelSession } from './sessions/voice-channel-session.js';
export { GatewayControl } from './control/gateway-control.js';

export default {
	async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (pathname === '/interactions') {
			return handleDiscordInteraction(request, env, ctx);
		}
		if (pathname === '/api/v1/gateway-control/connect') {
			return env.GATEWAY_CONTROL.getByName('default').fetch(request);
		}
		return handleSessionApi(request, env);
	},
} satisfies ExportedHandler<WorkerEnv>;
