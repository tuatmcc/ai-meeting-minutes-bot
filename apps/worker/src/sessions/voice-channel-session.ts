import { DurableObject } from 'cloudflare:workers';
import type { WorkerEnv } from '../env.js';
import type { SessionOperation, SessionState, VoiceSession } from './types.js';

type SessionRow = {
	session_id: string;
	guild_id: string;
	channel_id: string;
	request_id: string;
	state: SessionState;
	created_at: string;
	started_at: string | null;
	ended_at: string | null;
	manifest_key: string;
	notion_parent_page_id: string | null;
	notion_page_id: string | null;
	notion_page_url: string | null;
	duration_ms: number | null;
	manifest_size_bytes: number | null;
	error_code: string | null;
};

export class VoiceChannelSession extends DurableObject<WorkerEnv> {
	constructor(ctx: DurableObjectState, env: WorkerEnv) {
		super(ctx, env);
		void ctx.blockConcurrencyWhile(async () => {
			ctx.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS sessions (
					session_id TEXT PRIMARY KEY,
					guild_id TEXT NOT NULL,
					channel_id TEXT NOT NULL,
					request_id TEXT NOT NULL UNIQUE,
					state TEXT NOT NULL CHECK (state IN ('starting', 'recording', 'processing', 'completed', 'failed')),
					created_at TEXT NOT NULL,
					started_at TEXT,
					ended_at TEXT,
					manifest_key TEXT NOT NULL,
					notion_parent_page_id TEXT,
					notion_page_id TEXT,
					notion_page_url TEXT,
					duration_ms INTEGER,
					manifest_size_bytes INTEGER,
					error_code TEXT
				)
			`);
			const columns = ctx.storage.sql.exec<{ name: string }>('PRAGMA table_info(sessions)').toArray();
			if (!columns.some((column) => column.name === 'notion_parent_page_id')) {
				ctx.storage.sql.exec('ALTER TABLE sessions ADD COLUMN notion_parent_page_id TEXT');
			}
			if (!columns.some((column) => column.name === 'notion_page_id')) {
				ctx.storage.sql.exec('ALTER TABLE sessions ADD COLUMN notion_page_id TEXT');
			}
			if (!columns.some((column) => column.name === 'notion_page_url')) {
				ctx.storage.sql.exec('ALTER TABLE sessions ADD COLUMN notion_page_url TEXT');
			}
			ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS sessions_by_state ON sessions(state)');
		});
	}

	async getActiveSession(): Promise<VoiceSession | null> {
		const row = this.ctx.storage.sql
			.exec<SessionRow>(
				`SELECT * FROM sessions
				 WHERE state IN ('starting', 'recording', 'processing')
				 ORDER BY created_at DESC LIMIT 1`,
			)
			.toArray()[0];
		return row ? toSession(row) : null;
	}

	async startSession(
		guildId: string,
		channelId: string,
		requestId: string,
		notionParentPageId: string | null = null,
	): Promise<SessionOperation> {
		const existingRequest = this.findByRequestId(requestId);
		if (existingRequest) {
			return { ok: true, session: toSession(existingRequest) };
		}

		const activeSession = this.findActiveSession();
		if (activeSession) {
			return { ok: false, code: 'SESSION_ALREADY_ACTIVE', session: activeSession };
		}

		const sessionId = crypto.randomUUID();
		const createdAt = new Date().toISOString();
		const prefix = `guilds/${guildId}/voice-channels/${channelId}/sessions/${sessionId}`;
		this.ctx.storage.sql.exec(
			`INSERT INTO sessions (
				session_id, guild_id, channel_id, request_id, state, created_at,
				manifest_key, notion_parent_page_id
			) VALUES (?, ?, ?, ?, 'starting', ?, ?, ?)`,
			sessionId,
			guildId,
			channelId,
			requestId,
			createdAt,
			`${prefix}/manifest.json`,
			notionParentPageId,
		);

		return { ok: true, session: toSession(this.findBySessionId(sessionId)!) };
	}

	async setNotionPage(sessionId: string, pageId: string, pageUrl: string | null): Promise<SessionOperation> {
		const session = this.findBySessionId(sessionId);
		if (!session) {
			return { ok: false, code: 'SESSION_NOT_FOUND' };
		}
		if (session.notion_page_id) {
			return { ok: true, session: toSession(session) };
		}

		this.ctx.storage.sql.exec(
			'UPDATE sessions SET notion_page_id = ?, notion_page_url = ? WHERE session_id = ?',
			pageId,
			pageUrl,
			sessionId,
		);
		return { ok: true, session: toSession(this.findBySessionId(sessionId)!) };
	}

	async markRecordingStarted(sessionId: string): Promise<SessionOperation> {
		const session = this.findBySessionId(sessionId);
		if (!session) {
			return { ok: false, code: 'SESSION_NOT_FOUND' };
		}
		if (session.state === 'recording' || session.state === 'processing' || session.state === 'completed') {
			return { ok: true, session: toSession(session) };
		}
		if (session.state !== 'starting') {
			return { ok: false, code: 'INVALID_SESSION_STATE', session: toSession(session) };
		}

		this.ctx.storage.sql.exec(
			"UPDATE sessions SET state = 'recording', started_at = ? WHERE session_id = ?",
			new Date().toISOString(),
			sessionId,
		);
		return { ok: true, session: toSession(this.findBySessionId(sessionId)!) };
	}

	async markProcessingStarted(sessionId: string): Promise<SessionOperation> {
		const session = this.findBySessionId(sessionId);
		if (!session) {
			return { ok: false, code: 'SESSION_NOT_FOUND' };
		}
		if (session.state === 'processing' || session.state === 'completed') {
			return { ok: true, session: toSession(session) };
		}
		if (session.state !== 'recording') {
			return { ok: false, code: 'INVALID_SESSION_STATE', session: toSession(session) };
		}

		this.ctx.storage.sql.exec("UPDATE sessions SET state = 'processing' WHERE session_id = ?", sessionId);
		return { ok: true, session: toSession(this.findBySessionId(sessionId)!) };
	}

	async reserveUpload(sessionId: string): Promise<SessionOperation> {
		const session = this.findBySessionId(sessionId);
		if (!session) {
			return { ok: false, code: 'SESSION_NOT_FOUND' };
		}
		if (session.state === 'recording') {
			this.ctx.storage.sql.exec("UPDATE sessions SET state = 'processing' WHERE session_id = ?", sessionId);
			return { ok: true, session: toSession(this.findBySessionId(sessionId)!) };
		}
		if (session.state === 'processing') {
			return { ok: true, session: toSession(session) };
		}
		return { ok: false, code: 'INVALID_SESSION_STATE', session: toSession(session) };
	}

	async completeSession(
		sessionId: string,
		metadata: { endedAt: string; durationMs: number; manifestSizeBytes: number },
	): Promise<SessionOperation> {
		const session = this.findBySessionId(sessionId);
		if (!session) {
			return { ok: false, code: 'SESSION_NOT_FOUND' };
		}
		if (session.state === 'completed') {
			return { ok: true, session: toSession(session), completedNow: false };
		}
		if (session.state !== 'processing') {
			return { ok: false, code: 'INVALID_SESSION_STATE', session: toSession(session) };
		}

		this.ctx.storage.sql.exec(
			`UPDATE sessions
			 SET state = 'completed', ended_at = ?, duration_ms = ?,
			     manifest_size_bytes = ?
			 WHERE session_id = ?`,
			metadata.endedAt,
			metadata.durationMs,
			metadata.manifestSizeBytes,
			sessionId,
		);
		return { ok: true, session: toSession(this.findBySessionId(sessionId)!), completedNow: true };
	}

	async failSession(sessionId: string, errorCode: string): Promise<SessionOperation> {
		const session = this.findBySessionId(sessionId);
		if (!session) {
			return { ok: false, code: 'SESSION_NOT_FOUND' };
		}
		if (session.state === 'completed') {
			return { ok: false, code: 'INVALID_SESSION_STATE', session: toSession(session) };
		}
		if (session.state !== 'failed') {
			this.ctx.storage.sql.exec(
				"UPDATE sessions SET state = 'failed', ended_at = ?, error_code = ? WHERE session_id = ?",
				new Date().toISOString(),
				errorCode,
				sessionId,
			);
		}
		return { ok: true, session: toSession(this.findBySessionId(sessionId)!) };
	}

	private findBySessionId(sessionId: string): SessionRow | undefined {
		return this.ctx.storage.sql.exec<SessionRow>('SELECT * FROM sessions WHERE session_id = ?', sessionId).toArray()[0];
	}

	private findByRequestId(requestId: string): SessionRow | undefined {
		return this.ctx.storage.sql.exec<SessionRow>('SELECT * FROM sessions WHERE request_id = ?', requestId).toArray()[0];
	}

	private findActiveSession(): VoiceSession | undefined {
		const row = this.ctx.storage.sql
			.exec<SessionRow>(
				`SELECT * FROM sessions
				 WHERE state IN ('starting', 'recording', 'processing')
				 ORDER BY created_at DESC LIMIT 1`,
			)
			.toArray()[0];
		return row ? toSession(row) : undefined;
	}
}

function toSession(row: SessionRow): VoiceSession {
	return {
		sessionId: row.session_id,
		guildId: row.guild_id,
		channelId: row.channel_id,
		state: row.state,
		createdAt: row.created_at,
		startedAt: row.started_at,
		endedAt: row.ended_at,
		manifestKey: row.manifest_key,
		notionParentPageId: row.notion_parent_page_id,
		notionPageId: row.notion_page_id,
		notionPageUrl: row.notion_page_url,
		durationMs: row.duration_ms,
		manifestSizeBytes: row.manifest_size_bytes,
		errorCode: row.error_code,
	};
}
