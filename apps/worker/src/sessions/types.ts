export type SessionState = 'starting' | 'recording' | 'processing' | 'completed' | 'failed';
export type NotionPageStatus =
	| 'not_requested'
	| 'unknown'
	| 'pending'
	| 'creating'
	| 'created'
	| 'queued'
	| 'publishing'
	| 'retrying'
	| 'published'
	| 'failed';

export type VoiceSession = {
	sessionId: string;
	guildId: string;
	channelId: string;
	state: SessionState;
	createdAt: string;
	startedAt: string | null;
	endedAt: string | null;
	manifestKey: string;
	notionParentPageId: string | null;
	notionPageId: string | null;
	notionPageUrl: string | null;
	notionPageStatus: NotionPageStatus;
	notionAttemptCount: number;
	notionLastError: string | null;
	notionNextAttemptAt: number | null;
	durationMs: number | null;
	manifestSizeBytes: number | null;
	errorCode: string | null;
};

export type SessionOperation =
	| { ok: true; session: VoiceSession }
	| { ok: false; code: 'SESSION_ALREADY_ACTIVE' | 'SESSION_NOT_FOUND' | 'INVALID_SESSION_STATE'; session?: VoiceSession };
