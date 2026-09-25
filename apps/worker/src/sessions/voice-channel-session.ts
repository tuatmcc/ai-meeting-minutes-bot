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
	duration_ms: number | null;
	manifest_size_bytes: number | null;
	error_code: string | null;
};

export class VoiceChannelSession extends DurableObject<WorkerEnv> {
	constructor(ctx: DurableObjectState, env: WorkerEnv) {
		super(ctx, env);
		ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS sessions (
				session_id TEXT PRIMARY KEY,
				guild_id TEXT NOT NULL,
				channel_id TEXT NOT NULL,
				request_id TEXT NOT NULL UNIQUE,
				state TEXT NOT NULL CHECK (state IN ('starting', 'recording', 'uploading', 'completed', 'failed')),
				created_at TEXT NOT NULL,
				started_at TEXT,
				ended_at TEXT,
				manifest_key TEXT NOT NULL,
				duration_ms INTEGER,
				manifest_size_bytes INTEGER,
				error_code TEXT
			)
		`);
		ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS sessions_by_state ON sessions(state)');
	}

	async getActiveSession(): Promise<VoiceSession | null> {
		const row = this.ctx.storage.sql
			.exec<SessionRow>(
				`SELECT * FROM sessions
				 WHERE state IN ('starting', 'recording', 'uploading')
				 ORDER BY created_at DESC LIMIT 1`,
			)
			.toArray()[0];
		return row ? toSession(row) : null;
	}

	async startSession(guildId: string, channelId: string, requestId: string): Promise<SessionOperation> {
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
				manifest_key
			) VALUES (?, ?, ?, ?, 'starting', ?, ?)`,
			sessionId,
			guildId,
			channelId,
			requestId,
			createdAt,
			`${prefix}/manifest.json`,
		);

		return { ok: true, session: toSession(this.findBySessionId(sessionId)!) };
	}

	async markRecordingStarted(sessionId: string): Promise<SessionOperation> {
		const session = this.findBySessionId(sessionId);
		if (!session) {
			return { ok: false, code: 'SESSION_NOT_FOUND' };
		}
		if (session.state === 'recording' || session.state === 'uploading' || session.state === 'completed') {
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

	async reserveUpload(sessionId: string): Promise<SessionOperation> {
		const session = this.findBySessionId(sessionId);
		if (!session) {
			return { ok: false, code: 'SESSION_NOT_FOUND' };
		}
		if (session.state === 'recording') {
			this.ctx.storage.sql.exec("UPDATE sessions SET state = 'uploading' WHERE session_id = ?", sessionId);
			return { ok: true, session: toSession(this.findBySessionId(sessionId)!) };
		}
		if (session.state === 'uploading') {
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
			return { ok: true, session: toSession(session) };
		}
		if (session.state !== 'uploading') {
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
		return { ok: true, session: toSession(this.findBySessionId(sessionId)!) };
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
				 WHERE state IN ('starting', 'recording', 'uploading')
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
		durationMs: row.duration_ms,
		manifestSizeBytes: row.manifest_size_bytes,
		errorCode: row.error_code,
	};
}
