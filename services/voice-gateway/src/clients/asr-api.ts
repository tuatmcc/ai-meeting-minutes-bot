export type AsrTranscription = {
	model: string;
	language: string | null;
	text: string;
};

export type AsrSegmentMetadata = {
	index: number;
	speakerId: string;
	startMs: number;
	endMs: number;
};

export type AsrSession = { guildId: string; channelId: string; sessionId: string };

export class AsrApi {
	private readonly workerApiUrl: string;
	private readonly apiToken: string;
	private readonly request: typeof fetch;
	private readonly delay: (ms: number) => Promise<void>;
	constructor(
		workerApiUrl: string,
		apiToken: string,
		request: typeof fetch = fetch,
		delay: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	) {
		this.workerApiUrl = workerApiUrl;
		this.apiToken = apiToken;
		this.request = request;
		this.delay = delay;
	}

	async transcribeWav(session: AsrSession, audio: Buffer, metadata: AsrSegmentMetadata): Promise<AsrTranscription> {
		const url = new URL(
			`/api/v1/guilds/${session.guildId}/voice-channels/${session.channelId}/sessions/${session.sessionId}/transcribe`,
			this.workerApiUrl,
		);
		for (let attempt = 0; ; attempt += 1) {
			let response: Response;
			try {
				response = await this.request(url, {
					method: 'POST',
					headers: {
						Authorization: `Bearer ${this.apiToken}`,
						'Content-Type': 'audio/wav',
						'X-Segment-Index': String(metadata.index),
						'X-Speaker-Id': metadata.speakerId,
						'X-Start-Ms': String(metadata.startMs),
						'X-End-Ms': String(metadata.endMs),
					},
					signal: AbortSignal.timeout(120_000),
					body: new Uint8Array(audio),
				});
			} catch (error) {
				if (attempt >= 3) throw error;
				await this.delay(1000 * 2 ** attempt);
				continue;
			}
			if ((response.status === 429 || response.status >= 500) && attempt < 3) {
				const retryAfter = Number(response.headers.get('Retry-After'));
				await response.body?.cancel().catch(() => undefined);
				await this.delay(Math.min(30_000, Math.max(1000 * 2 ** attempt, Number.isFinite(retryAfter) ? retryAfter * 1000 : 0)));
				continue;
			}
			if (!response.ok) throw new Error(`Worker transcription failed with HTTP ${response.status}`);
			let body: unknown;
			try {
				body = await response.json();
			} catch (error) {
				if (attempt >= 3) throw error;
				await this.delay(1000 * 2 ** attempt);
				continue;
			}
			if (!isAsrTranscription(body)) throw new Error('Worker transcription returned an invalid response');
			return body;
		}
	}
}

function isAsrTranscription(value: unknown): value is AsrTranscription {
	if (typeof value !== 'object' || value === null) return false;
	const body = value as Record<string, unknown>;
	return typeof body.model === 'string' && (body.language === null || typeof body.language === 'string') && typeof body.text === 'string';
}
