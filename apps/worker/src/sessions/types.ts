export type SessionState = 'starting' | 'recording' | 'uploading' | 'completed' | 'failed';

export type VoiceSession = {
	sessionId: string;
	guildId: string;
	channelId: string;
	state: SessionState;
	createdAt: string;
	startedAt: string | null;
	endedAt: string | null;
	recordingKey: string;
	manifestKey: string;
	durationMs: number | null;
	recordingSizeBytes: number | null;
	manifestSizeBytes: number | null;
	errorCode: string | null;
};

export type SessionOperation =
	| { ok: true; session: VoiceSession }
	| { ok: false; code: 'SESSION_ALREADY_ACTIVE' | 'SESSION_NOT_FOUND' | 'INVALID_SESSION_STATE'; session?: VoiceSession };
