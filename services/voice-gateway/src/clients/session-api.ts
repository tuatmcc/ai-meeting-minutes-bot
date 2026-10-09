import type { MeetingTranscription } from './transcription-segmenter.ts';

export type Session = {
	sessionId: string;
	guildId: string;
	channelId: string;
	state: 'starting' | 'recording' | 'processing' | 'completed' | 'failed';
	manifestKey: string;
};

export type UploadTarget = {
	key: string;
	url: string;
	contentType: string;
};

export type SessionResumeInfo = {
	segmentIndexOffset: number;
	timeOffsetMs: number;
	manifest: {
		startedAt: string;
		durationMs: number;
		transcription: MeetingTranscription;
	};
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

	async getActiveSession(guildId: string, channelId: string): Promise<Session | null> {
		const result = await this.request<{ session: Session | null }>(`${this.channelPath(guildId, channelId)}/active`, {
			method: 'GET',
		});
		return result.session;
	}

	async getResumeInfo(guildId: string, channelId: string, sessionId: string): Promise<SessionResumeInfo> {
		const result = await this.request<unknown>(this.sessionPath(guildId, channelId, sessionId, 'resume-info'), { method: 'GET' });
		if (!isSessionResumeInfo(result)) throw new Error('Worker returned invalid session resume data');
		return result;
	}

	async summarizeTranscript(guildId: string, channelId: string, sessionId: string, transcript: string): Promise<string> {
		const result = await this.request<{ summary: string }>(this.sessionPath(guildId, channelId, sessionId, 'summary'), {
			method: 'POST',
			body: JSON.stringify({ transcript }),
		});
		return result.summary;
	}

	async markRecordingStarted(guildId: string, channelId: string, sessionId: string): Promise<void> {
		await this.request(this.sessionPath(guildId, channelId, sessionId, 'recording-started'), { method: 'POST' });
	}

	async markProcessingStarted(guildId: string, channelId: string, sessionId: string): Promise<void> {
		await this.request(this.sessionPath(guildId, channelId, sessionId, 'processing-started'), { method: 'POST' });
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
		metadata: { endedAt: string; durationMs: number; manifestSizeBytes: number },
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

function isSessionResumeInfo(value: unknown): value is SessionResumeInfo {
	if (typeof value !== 'object' || value === null) return false;
	const resume = value as Record<string, unknown>;
	if (
		typeof resume.segmentIndexOffset !== 'number' ||
		!Number.isSafeInteger(resume.segmentIndexOffset) ||
		resume.segmentIndexOffset < 0 ||
		typeof resume.timeOffsetMs !== 'number' ||
		!Number.isSafeInteger(resume.timeOffsetMs) ||
		resume.timeOffsetMs < 0 ||
		typeof resume.manifest !== 'object' ||
		resume.manifest === null
	) {
		return false;
	}
	const manifest = resume.manifest as Record<string, unknown>;
	if (
		typeof manifest.startedAt !== 'string' ||
		typeof manifest.durationMs !== 'number' ||
		!Number.isFinite(manifest.durationMs) ||
		typeof manifest.transcription !== 'object' ||
		manifest.transcription === null
	) {
		return false;
	}
	const transcription = manifest.transcription as Record<string, unknown>;
	return (
		typeof transcription.model === 'string' &&
		(transcription.language === null || typeof transcription.language === 'string') &&
		typeof transcription.text === 'string' &&
		Array.isArray(transcription.segments)
	);
}
