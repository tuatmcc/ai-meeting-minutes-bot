import { DurableObject } from 'cloudflare:workers';
import type { WorkerEnv } from '../env.js';
import type { GatewayCommand, GatewayEnqueueResult } from './types.js';

type CommandRow = {
	command_id: string;
	payload: string;
	state: 'pending' | 'in_flight';
};

type ActiveSessionRow = {
	session_id: string;
	guild_id: string;
	channel_id: string;
};

type GatewayAttachment = {
	authenticated: boolean;
};

const CONTROL_PATH = '/api/v1/gateway-control/connect';
const COMMAND_ACK_TIMEOUT_MS = 60_000;
const GATEWAY_DISCONNECT_GRACE_MS = 60_000;
const GATEWAY_DISCONNECTED_AT_KEY = 'gateway-disconnected-at';

export class GatewayControl extends DurableObject<WorkerEnv> {
	constructor(ctx: DurableObjectState, env: WorkerEnv) {
		super(ctx, env);
		ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS commands (
				command_id TEXT PRIMARY KEY,
				payload TEXT NOT NULL,
				state TEXT NOT NULL CHECK (state IN ('pending', 'in_flight')),
				created_at TEXT NOT NULL
			)
		`);
		ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS commands_by_state ON commands(state, created_at)');
		ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS active_sessions (
				session_id TEXT PRIMARY KEY,
				guild_id TEXT NOT NULL,
				channel_id TEXT NOT NULL
			)
		`);
	}

	async enqueueCommand(command: GatewayCommand): Promise<GatewayEnqueueResult> {
		this.ctx.storage.sql.exec(
			`INSERT OR IGNORE INTO commands (command_id, payload, state, created_at)
			 VALUES (?, ?, 'pending', ?)`,
			command.commandId,
			JSON.stringify(command),
			new Date().toISOString(),
		);
		await this.dispatchNext();
		return { gatewayConnected: this.authenticatedGatewaySocket() !== null };
	}

	getConnectionStatus(): 'connected' | 'disconnected' {
		return this.authenticatedGatewaySocket() ? 'connected' : 'disconnected';
	}

	async alarm(): Promise<void> {
		const disconnectedAt = await this.ctx.storage.get<number>(GATEWAY_DISCONNECTED_AT_KEY);
		if (disconnectedAt !== undefined && !this.authenticatedGatewaySocket()) {
			const failureAt = disconnectedAt + GATEWAY_DISCONNECT_GRACE_MS;
			if (Date.now() < failureAt) {
				await this.ctx.storage.setAlarm(failureAt);
				return;
			}
			if (!(await this.failDisconnectedSessions())) {
				await this.ctx.storage.setAlarm(Date.now() + COMMAND_ACK_TIMEOUT_MS);
				return;
			}
			await this.ctx.storage.delete(GATEWAY_DISCONNECTED_AT_KEY);
		}

		const inFlight = this.ctx.storage.sql
			.exec<CommandRow>("SELECT * FROM commands WHERE state = 'in_flight' ORDER BY created_at, rowid LIMIT 1")
			.toArray()[0];
		if (!inFlight) {
			await this.ctx.storage.deleteAlarm();
			return;
		}

		console.warn('[gateway-control] command acknowledgement timed out', { commandId: inFlight.command_id });
		this.authenticatedGatewaySocket()?.close(1011, 'Command acknowledgement timed out');
		await this.ctx.storage.setAlarm(Date.now() + COMMAND_ACK_TIMEOUT_MS);
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (request.method !== 'GET' || url.pathname !== CONTROL_PATH || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
			return new Response('Not found', { status: 404 });
		}

		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];
		this.ctx.acceptWebSocket(server, ['gateway']);
		server.serializeAttachment({ authenticated: false } satisfies GatewayAttachment);
		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}

	async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
		const attachment = socket.deserializeAttachment() as GatewayAttachment | null;
		const frame = parseFrame(message);
		if (!attachment?.authenticated) {
			if (frame?.type !== 'authenticate' || typeof frame.token !== 'string' || !(await this.isValidToken(frame.token))) {
				socket.close(1008, 'Unauthorized');
				return;
			}
			const activeSessionIds = frame.activeSessionIds === undefined ? null : parseActiveSessionIds(frame.activeSessionIds);
			if (frame.activeSessionIds !== undefined && activeSessionIds === null) {
				socket.close(1008, 'Invalid active session list');
				return;
			}
			socket.serializeAttachment({ authenticated: true } satisfies GatewayAttachment);
			for (const existingSocket of this.ctx.getWebSockets('gateway')) {
				if (existingSocket === socket) {
					continue;
				}
				const existingAttachment = existingSocket.deserializeAttachment() as GatewayAttachment | null;
				if (existingAttachment?.authenticated) {
					existingSocket.close(1012, 'Replaced by a new gateway connection');
				}
			}
			await this.ctx.storage.delete(GATEWAY_DISCONNECTED_AT_KEY);
			if (activeSessionIds) {
				await this.reconcileActiveSessions(activeSessionIds);
			}
			socket.send(JSON.stringify({ type: 'authenticated' }));
			await this.dispatchNext(true);
			return;
		}
		if (frame?.type === 'heartbeat' && typeof frame.heartbeatId === 'string' && frame.heartbeatId.length <= 32) {
			socket.send(JSON.stringify({ type: 'heartbeat_ack', heartbeatId: frame.heartbeatId }));
			return;
		}

		if (frame?.type !== 'ack' || typeof frame.commandId !== 'string') {
			socket.close(1008, 'Invalid frame');
			return;
		}
		const inFlight = this.ctx.storage.sql
			.exec<CommandRow>("SELECT * FROM commands WHERE state = 'in_flight' ORDER BY created_at, rowid LIMIT 1")
			.toArray()[0];
		if (inFlight?.command_id !== frame.commandId) {
			console.error('[gateway-control] unexpected command acknowledgement', {
				commandId: frame.commandId,
				inFlightCommandId: inFlight?.command_id ?? null,
			});
			socket.close(1008, 'Unexpected command acknowledgement');
			return;
		}

		const command = JSON.parse(inFlight.payload) as GatewayCommand;
		if (command.action === 'start') {
			this.ctx.storage.sql.exec(
				`INSERT OR REPLACE INTO active_sessions (session_id, guild_id, channel_id)
				 VALUES (?, ?, ?)`,
				command.sessionId,
				command.guildId,
				command.channelId,
			);
		} else if (command.action === 'stop') {
			this.ctx.storage.sql.exec('DELETE FROM active_sessions WHERE session_id = ?', command.sessionId);
		}
		this.ctx.storage.sql.exec("DELETE FROM commands WHERE command_id = ? AND state = 'in_flight'", frame.commandId);
		console.log('[gateway-control] command acknowledged', { commandId: frame.commandId });
		await this.dispatchNext();
	}

	async webSocketClose(socket: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
		console.warn('[gateway-control] socket closed', { code, reason, wasClean });
		const attachment = socket.deserializeAttachment() as GatewayAttachment | null;
		if (!attachment?.authenticated || this.authenticatedGatewaySocket()) {
			return;
		}

		const disconnectedAt = (await this.ctx.storage.get<number>(GATEWAY_DISCONNECTED_AT_KEY)) ?? Date.now();
		await this.ctx.storage.put(GATEWAY_DISCONNECTED_AT_KEY, disconnectedAt);
		await this.ctx.storage.setAlarm(disconnectedAt + GATEWAY_DISCONNECT_GRACE_MS);
	}

	private async reconcileActiveSessions(activeSessionIds: Set<string>): Promise<void> {
		for (const session of this.ctx.storage.sql.exec<ActiveSessionRow>('SELECT * FROM active_sessions').toArray()) {
			if (activeSessionIds.has(session.session_id)) {
				continue;
			}

			try {
				await this.env.VOICE_CHANNEL_SESSION.getByName(`${session.guild_id}:${session.channel_id}`).failSessionForGatewayDisconnect(
					session.session_id,
				);
				this.ctx.storage.sql.exec('DELETE FROM active_sessions WHERE session_id = ?', session.session_id);
			} catch (error) {
				console.error('[gateway-control] failed to reconcile disconnected gateway session', {
					sessionId: session.session_id,
					error: error instanceof Error ? error.name : 'unknown',
				});
			}
		}
	}

	private async failDisconnectedSessions(): Promise<boolean> {
		let failed = false;
		const sessions = new Map<string, ActiveSessionRow>();
		for (const session of this.ctx.storage.sql.exec<ActiveSessionRow>('SELECT * FROM active_sessions').toArray()) {
			sessions.set(session.session_id, session);
		}

		const inFlight = this.ctx.storage.sql
			.exec<CommandRow>("SELECT * FROM commands WHERE state = 'in_flight' ORDER BY created_at, rowid LIMIT 1")
			.toArray()[0];
		if (inFlight) {
			const command = JSON.parse(inFlight.payload) as GatewayCommand;
			sessions.set(command.sessionId, {
				session_id: command.sessionId,
				guild_id: command.guildId,
				channel_id: command.channelId,
			});
		}

		for (const session of sessions.values()) {
			try {
				await this.env.VOICE_CHANNEL_SESSION.getByName(`${session.guild_id}:${session.channel_id}`).failSessionForGatewayDisconnect(
					session.session_id,
				);
				this.ctx.storage.sql.exec('DELETE FROM active_sessions WHERE session_id = ?', session.session_id);
			} catch (error) {
				failed = true;
				console.error('[gateway-control] failed to end disconnected gateway session', {
					sessionId: session.session_id,
					error: error instanceof Error ? error.name : 'unknown',
				});
			}
		}
		if (!failed && inFlight) {
			this.ctx.storage.sql.exec("DELETE FROM commands WHERE command_id = ? AND state = 'in_flight'", inFlight.command_id);
		}
		return !failed;
	}

	webSocketError(socket: WebSocket): void {
		socket.close(1011, 'Gateway connection failed');
	}

	private async dispatchNext(resendInFlight = false): Promise<void> {
		const socket = this.authenticatedGatewaySocket();
		if (!socket) {
			return;
		}

		let row = this.ctx.storage.sql
			.exec<CommandRow>("SELECT * FROM commands WHERE state = 'in_flight' ORDER BY created_at, rowid LIMIT 1")
			.toArray()[0];
		if (!row) {
			row = this.ctx.storage.sql
				.exec<CommandRow>("SELECT * FROM commands WHERE state = 'pending' ORDER BY created_at, rowid LIMIT 1")
				.toArray()[0];
			if (!row) {
				const disconnectedAt = await this.ctx.storage.get<number>(GATEWAY_DISCONNECTED_AT_KEY);
				if (disconnectedAt !== undefined) {
					await this.ctx.storage.setAlarm(Math.max(Date.now(), disconnectedAt + GATEWAY_DISCONNECT_GRACE_MS));
				} else {
					await this.ctx.storage.deleteAlarm();
				}
				return;
			}
			this.ctx.storage.sql.exec("UPDATE commands SET state = 'in_flight' WHERE command_id = ?", row.command_id);
		} else if (!resendInFlight) {
			return;
		}

		try {
			socket.send(JSON.stringify({ type: 'command', command: JSON.parse(row.payload) }));
			console.log('[gateway-control] command dispatched', { commandId: row.command_id });
			await this.ctx.storage.setAlarm(Date.now() + COMMAND_ACK_TIMEOUT_MS);
		} catch {
			this.ctx.storage.sql.exec("UPDATE commands SET state = 'pending' WHERE command_id = ?", row.command_id);
			socket.close(1011, 'Unable to deliver command');
		}
	}

	private authenticatedGatewaySocket(): WebSocket | null {
		for (const socket of this.ctx.getWebSockets('gateway')) {
			if (socket.readyState !== WebSocket.OPEN) {
				continue;
			}
			const attachment = socket.deserializeAttachment() as GatewayAttachment | null;
			if (attachment?.authenticated) {
				return socket;
			}
		}
		return null;
	}

	private async isValidToken(providedToken: string): Promise<boolean> {
		if (!this.env.GATEWAY_CONTROL_TOKEN) {
			return false;
		}
		const encoder = new TextEncoder();
		const [providedHash, expectedHash] = await Promise.all([
			crypto.subtle.digest('SHA-256', encoder.encode(providedToken)),
			crypto.subtle.digest('SHA-256', encoder.encode(this.env.GATEWAY_CONTROL_TOKEN)),
		]);
		return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
	}
}

function parseFrame(message: string | ArrayBuffer): Record<string, unknown> | null {
	try {
		if (typeof message === 'string' ? message.length > 4096 : message.byteLength > 4096) {
			return null;
		}
		const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
		const value: unknown = JSON.parse(text);
		return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function parseActiveSessionIds(value: unknown): Set<string> | null {
	if (!Array.isArray(value)) {
		return null;
	}
	const sessionIds = new Set<string>();
	for (const sessionId of value) {
		if (typeof sessionId !== 'string' || sessionIds.has(sessionId)) {
			return null;
		}
		sessionIds.add(sessionId);
	}
	return sessionIds;
}
