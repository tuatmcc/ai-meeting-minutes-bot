import { DurableObject } from 'cloudflare:workers';
import type { WorkerEnv } from '../env.js';
import { createMeetingPage, publishMeetingToNotion } from '../notion/meeting-pages.js';
import type { NotionPageStatus, SessionOperation, SessionState, VoiceSession } from './types.js';

const MAX_NOTION_ATTEMPTS = 5;
const INITIAL_NOTION_RETRY_MS = 5_000;
const MAX_NOTION_RETRY_MS = 5 * 60_000;

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
	notion_page_status: NotionPageStatus;
	notion_attempt_count: number;
	notion_last_error: string | null;
	notion_next_attempt_at: number | null;
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
					notion_page_status TEXT NOT NULL DEFAULT 'not_requested',
					notion_attempt_count INTEGER NOT NULL DEFAULT 0,
					notion_last_error TEXT,
					notion_next_attempt_at INTEGER,
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
			if (!columns.some((column) => column.name === 'notion_page_status')) {
				ctx.storage.sql.exec("ALTER TABLE sessions ADD COLUMN notion_page_status TEXT NOT NULL DEFAULT 'not_requested'");
			}
			if (!columns.some((column) => column.name === 'notion_attempt_count')) {
				ctx.storage.sql.exec('ALTER TABLE sessions ADD COLUMN notion_attempt_count INTEGER NOT NULL DEFAULT 0');
			}
			if (!columns.some((column) => column.name === 'notion_last_error')) {
				ctx.storage.sql.exec('ALTER TABLE sessions ADD COLUMN notion_last_error TEXT');
			}
			if (!columns.some((column) => column.name === 'notion_next_attempt_at')) {
				ctx.storage.sql.exec('ALTER TABLE sessions ADD COLUMN notion_next_attempt_at INTEGER');
			}
			ctx.storage.sql.exec(
				`UPDATE sessions
				 SET notion_page_status = CASE
					 WHEN notion_parent_page_id IS NULL THEN 'not_requested'
					 WHEN state = 'completed' THEN 'unknown'
					 WHEN notion_page_id IS NULL THEN 'pending'
					 ELSE 'created'
				 END
				 WHERE notion_page_status = 'not_requested' AND notion_parent_page_id IS NOT NULL`,
			);
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
				manifest_key, notion_parent_page_id, notion_page_status
			) VALUES (?, ?, ?, ?, 'starting', ?, ?, ?, ?)`,
			sessionId,
			guildId,
			channelId,
			requestId,
			createdAt,
			`${prefix}/manifest.json`,
			notionParentPageId,
			notionParentPageId ? 'pending' : 'not_requested',
		);

		return { ok: true, session: toSession(this.findBySessionId(sessionId)!) };
	}

	async markNotionPageCreating(
		sessionId: string,
	): Promise<{ ok: true; session: VoiceSession; claimed: boolean } | { ok: false; code: 'SESSION_NOT_FOUND' }> {
		const session = this.findBySessionId(sessionId);
		if (!session) {
			return { ok: false, code: 'SESSION_NOT_FOUND' };
		}
		if (!session.notion_parent_page_id || session.notion_page_id || session.notion_page_status === 'creating') {
			return { ok: true, session: toSession(session), claimed: false };
		}

		this.ctx.storage.sql.exec(
			"UPDATE sessions SET notion_page_status = 'creating', notion_last_error = NULL WHERE session_id = ?",
			sessionId,
		);
		return { ok: true, session: toSession(this.findBySessionId(sessionId)!), claimed: true };
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
			"UPDATE sessions SET notion_page_id = ?, notion_page_url = ?, notion_page_status = 'created', notion_last_error = NULL, notion_next_attempt_at = NULL WHERE session_id = ?",
			pageId,
			pageUrl,
			sessionId,
		);
		return { ok: true, session: toSession(this.findBySessionId(sessionId)!) };
	}

	async failNotionPageCreation(sessionId: string, error: string): Promise<SessionOperation> {
		const session = this.findBySessionId(sessionId);
		if (!session) {
			return { ok: false, code: 'SESSION_NOT_FOUND' };
		}
		this.ctx.storage.sql.exec(
			"UPDATE sessions SET notion_page_status = 'failed', notion_last_error = ?, notion_next_attempt_at = NULL WHERE session_id = ?",
			truncateError(error),
			sessionId,
		);
		return { ok: true, session: toSession(this.findBySessionId(sessionId)!) };
	}

	async retryLatestNotionExport(): Promise<VoiceSession | null> {
		const session = this.ctx.storage.sql
			.exec<SessionRow>(
				`SELECT * FROM sessions
				 WHERE state = 'completed'
				   AND notion_parent_page_id IS NOT NULL
				   AND notion_page_status = 'failed'
				 ORDER BY ended_at DESC
				 LIMIT 1`,
			)
			.toArray()[0];
		if (!session) {
			return null;
		}

		this.ctx.storage.sql.exec(
			"UPDATE sessions SET notion_page_status = 'queued', notion_attempt_count = 0, notion_next_attempt_at = ? WHERE session_id = ?",
			Date.now(),
			session.session_id,
		);
		await this.ctx.storage.setAlarm(Date.now());
		return toSession(this.findBySessionId(session.session_id)!);
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
			return { ok: true, session: toSession(session) };
		}
		if (session.state !== 'processing') {
			return { ok: false, code: 'INVALID_SESSION_STATE', session: toSession(session) };
		}

		this.ctx.storage.sql.exec(
			`UPDATE sessions
			 SET state = 'completed', ended_at = ?, duration_ms = ?,
			     manifest_size_bytes = ?,
			     notion_page_status = CASE WHEN notion_parent_page_id IS NULL THEN notion_page_status ELSE 'queued' END,
			     notion_attempt_count = 0,
			     notion_last_error = NULL,
			     notion_next_attempt_at = CASE WHEN notion_parent_page_id IS NULL THEN NULL ELSE ? END
			 WHERE session_id = ?`,
			metadata.endedAt,
			metadata.durationMs,
			metadata.manifestSizeBytes,
			Date.now(),
			sessionId,
		);
		if (session.notion_parent_page_id) {
			await this.ctx.storage.setAlarm(Date.now());
		}
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
				`UPDATE sessions
				 SET state = 'failed', ended_at = ?, error_code = ?,
				     notion_page_status = CASE WHEN notion_parent_page_id IS NULL THEN notion_page_status ELSE 'failed' END,
				     notion_last_error = CASE WHEN notion_parent_page_id IS NULL THEN notion_last_error ELSE ? END,
				     notion_next_attempt_at = NULL
				 WHERE session_id = ?`,
				new Date().toISOString(),
				errorCode,
				errorCode,
				sessionId,
			);
		}
		return { ok: true, session: toSession(this.findBySessionId(sessionId)!) };
	}

	async alarm(): Promise<void> {
		const now = Date.now();
		const row = this.ctx.storage.sql
			.exec<SessionRow>(
				`SELECT * FROM sessions
				 WHERE notion_page_status IN ('queued', 'retrying', 'publishing')
				   AND COALESCE(notion_next_attempt_at, 0) <= ?
				 ORDER BY COALESCE(notion_next_attempt_at, 0), created_at
				 LIMIT 1`,
				now,
			)
			.toArray()[0];

		if (!row) {
			await this.scheduleNextNotionExport();
			return;
		}

		const attemptCount = row.notion_attempt_count + 1;
		this.ctx.storage.sql.exec(
			"UPDATE sessions SET notion_page_status = 'publishing', notion_attempt_count = ?, notion_next_attempt_at = NULL WHERE session_id = ?",
			attemptCount,
			row.session_id,
		);

		try {
			let session = toSession(this.findBySessionId(row.session_id)!);
			if (!session.notionPageId) {
				const page = await createMeetingPage(this.env, session);
				this.ctx.storage.sql.exec(
					'UPDATE sessions SET notion_page_id = ?, notion_page_url = ? WHERE session_id = ?',
					page.pageId,
					page.pageUrl,
					session.sessionId,
				);
				session = toSession(this.findBySessionId(session.sessionId)!);
			}

			await publishMeetingToNotion(this.env, session);
			this.ctx.storage.sql.exec(
				"UPDATE sessions SET notion_page_status = 'published', notion_last_error = NULL, notion_next_attempt_at = NULL WHERE session_id = ?",
				session.sessionId,
			);
			console.log('[notion] meeting page saved', session.notionPageUrl ?? session.notionPageId);
		} catch (error) {
			const message = truncateError(error instanceof Error ? error.message : String(error));
			const isFinalAttempt = attemptCount >= MAX_NOTION_ATTEMPTS;
			const nextAttemptAt = isFinalAttempt
				? null
				: Date.now() + Math.min(INITIAL_NOTION_RETRY_MS * 2 ** (attemptCount - 1), MAX_NOTION_RETRY_MS);
			this.ctx.storage.sql.exec(
				`UPDATE sessions
				 SET notion_page_status = ?, notion_last_error = ?, notion_next_attempt_at = ?
				 WHERE session_id = ?`,
				isFinalAttempt ? 'failed' : 'retrying',
				message,
				nextAttemptAt,
				row.session_id,
			);
			console.error(`[notion] export attempt ${attemptCount} failed for ${row.session_id}`, message);
		}

		await this.scheduleNextNotionExport();
	}

	private async scheduleNextNotionExport(): Promise<void> {
		const now = Date.now();
		const nextAttempt = this.ctx.storage.sql
			.exec<{ next_attempt_at: number | null }>(
				`SELECT MIN(COALESCE(notion_next_attempt_at, ?)) AS next_attempt_at
				 FROM sessions
				 WHERE notion_page_status IN ('queued', 'retrying', 'publishing')`,
				now,
			)
			.one().next_attempt_at;
		if (nextAttempt === null) {
			await this.ctx.storage.deleteAlarm();
			return;
		}
		await this.ctx.storage.setAlarm(Math.max(now, nextAttempt));
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
		notionPageStatus: row.notion_page_status,
		notionAttemptCount: row.notion_attempt_count,
		notionLastError: row.notion_last_error,
		notionNextAttemptAt: row.notion_next_attempt_at,
		durationMs: row.duration_ms,
		manifestSizeBytes: row.manifest_size_bytes,
		errorCode: row.error_code,
	};
}

function truncateError(message: string): string {
	return message.slice(0, 500);
}
