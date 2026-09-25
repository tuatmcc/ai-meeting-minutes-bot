export type Session = {
	sessionId: string;
	guildId: string;
	channelId: string;
	state: 'starting' | 'recording' | 'uploading' | 'completed' | 'failed';
	recordingKey: string;
	manifestKey: string;
};

export type UploadTarget = {
	key: string;
	url: string;
	contentType: string;
};

export class SessionApi {
	private readonly baseUrl: URL;

	constructor(
		workerApiUrl: string,
		private readonly token: string,
	) {
		this.baseUrl = new URL(workerApiUrl.endsWith('/') ? workerApiUrl : `${workerApiUrl}/`);
	}

	async startSession(guildId: string, channelId: string, requestId: string): Promise<Session> {
		const result = await this.request<{ session: Session }>(this.channelPath(guildId, channelId), {
			method: 'POST',
			headers: { 'Idempotency-Key': requestId },
		});
		return result.session;
	}

	async markRecordingStarted(guildId: string, channelId: string, sessionId: string): Promise<void> {
		await this.request(this.sessionPath(guildId, channelId, sessionId, 'recording-started'), { method: 'POST' });
	}

	async createUploadTargets(guildId: string, channelId: string, sessionId: string): Promise<UploadTarget[]> {
		const result = await this.request<{ uploads: UploadTarget[] }>(this.sessionPath(guildId, channelId, sessionId, 'upload-targets'), {
			method: 'POST',
		});
		return result.uploads;
	}

	async completeSession(
		guildId: string,
		channelId: string,
		sessionId: string,
		metadata: { endedAt: string; durationMs: number; recordingSizeBytes: number; manifestSizeBytes: number },
	): Promise<void> {
		await this.request(this.sessionPath(guildId, channelId, sessionId, 'completed'), {
			method: 'POST',
			body: JSON.stringify(metadata),
		});
	}

	async failSession(guildId: string, channelId: string, sessionId: string, errorCode: string): Promise<void> {
		await this.request(this.sessionPath(guildId, channelId, sessionId, 'failed'), {
			method: 'POST',
			body: JSON.stringify({ errorCode }),
		});
	}

	private channelPath(guildId: string, channelId: string): string {
		return `api/v1/guilds/${guildId}/voice-channels/${channelId}/sessions`;
	}

	private sessionPath(guildId: string, channelId: string, sessionId: string, action: string): string {
		return `${this.channelPath(guildId, channelId)}/${sessionId}/${action}`;
	}

	private async request<T = unknown>(path: string, init: RequestInit): Promise<T> {
		const headers = new Headers(init.headers);
		headers.set('Authorization', `Bearer ${this.token}`);
		if (init.body !== undefined) {
			headers.set('Content-Type', 'application/json');
		}

		const url = new URL(path, this.baseUrl);
		let response: Response;
		try {
			response = await fetch(url, { ...init, headers });
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 250));
			response = await fetch(url, { ...init, headers });
		}
		const body: unknown = await response.json().catch(() => undefined);
		if (!response.ok) {
			const errorCode =
				typeof body === 'object' &&
				body !== null &&
				'error' in body &&
				typeof body.error === 'object' &&
				body.error !== null &&
				'code' in body.error
					? String(body.error.code)
					: `HTTP_${response.status}`;
			throw new Error(`Worker session API failed: ${errorCode}`);
		}
		return body as T;
	}
}
