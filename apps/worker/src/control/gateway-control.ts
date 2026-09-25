import { DurableObject } from 'cloudflare:workers';
import type { WorkerEnv } from '../env.js';
import type { GatewayCommand, GatewayEnqueueResult } from './types.js';

type CommandRow = {
	command_id: string;
	payload: string;
	state: 'pending' | 'in_flight';
};

type GatewayAttachment = {
	authenticated: boolean;
};

const CONTROL_PATH = '/api/v1/gateway-control/connect';

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
	}

	async enqueueCommand(command: GatewayCommand): Promise<GatewayEnqueueResult> {
		this.ctx.storage.sql.exec(
			`INSERT OR IGNORE INTO commands (command_id, payload, state, created_at)
			 VALUES (?, ?, 'pending', ?)`,
			command.commandId,
			JSON.stringify(command),
			new Date().toISOString(),
		);
		this.dispatchNext();
		return { gatewayConnected: this.authenticatedGatewaySocket() !== null };
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
			socket.serializeAttachment({ authenticated: true } satisfies GatewayAttachment);
			socket.send(JSON.stringify({ type: 'authenticated' }));
			this.dispatchNext(true);
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
			socket.close(1008, 'Unexpected command acknowledgement');
			return;
		}

		this.ctx.storage.sql.exec("DELETE FROM commands WHERE command_id = ? AND state = 'in_flight'", frame.commandId);
		this.dispatchNext();
	}

	webSocketClose(socket: WebSocket): void {
		socket.close();
	}

	webSocketError(socket: WebSocket): void {
		socket.close(1011, 'Gateway connection failed');
	}

	private dispatchNext(resendInFlight = false): void {
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
				return;
			}
			this.ctx.storage.sql.exec("UPDATE commands SET state = 'in_flight' WHERE command_id = ?", row.command_id);
		} else if (!resendInFlight) {
			return;
		}

		try {
			socket.send(JSON.stringify({ type: 'command', command: JSON.parse(row.payload) }));
		} catch {
			this.ctx.storage.sql.exec("UPDATE commands SET state = 'pending' WHERE command_id = ?", row.command_id);
			socket.close(1011, 'Unable to deliver command');
		}
	}

	private authenticatedGatewaySocket(): WebSocket | null {
		for (const socket of this.ctx.getWebSockets('gateway')) {
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
