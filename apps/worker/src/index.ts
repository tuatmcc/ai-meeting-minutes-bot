import type { WorkerEnv } from './env.js';
import { handleSessionApi } from './api/session-api.js';

export { VoiceChannelSession } from './sessions/voice-channel-session.js';

export default {
	async fetch(request: Request, env: WorkerEnv): Promise<Response> {
		return handleSessionApi(request, env);
	},
} satisfies ExportedHandler<WorkerEnv>;
