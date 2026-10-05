type BaseGatewayCommand = {
	commandId: string;
	guildId: string;
	channelId: string;
	sessionId: string;
};

export type GatewayCommand = BaseGatewayCommand &
	({ action: 'start' | 'stop' } | { action: 'imakita'; applicationId: string; interactionToken: string });

type ControlMessage =
	| { type: 'authenticated' }
	| { type: 'heartbeat_ack'; heartbeatId: string }
	| { type: 'command'; command: GatewayCommand };

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const AUTHENTICATION_TIMEOUT_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_TIMEOUT_MS = 30_000;
const SNOWFLAKE_PATTERN = /^\d{17,20}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class GatewayControlClient {
	private stopping = false;
	private socket: WebSocket | undefined;
	private pendingCommand = Promise.resolve();
	private reconnectTimer: NodeJS.Timeout | undefined;
	private finishReconnectDelay: (() => void) | undefined;

	constructor(
		private readonly url: string,
		private readonly token: string,
		private readonly onCommand: (command: GatewayCommand) => Promise<void>,
	) {}

	async run(): Promise<void> {
		let delayMs = INITIAL_RECONNECT_DELAY_MS;
		while (!this.stopping) {
			const connectedAt = Date.now();
			try {
				await this.connectOnce();
			} catch (error) {
				console.error('[gateway-control] connection failed', error instanceof Error ? error.message : error);
			}

			if (this.stopping) {
				break;
			}
			if (Date.now() - connectedAt >= 60_000) {
				delayMs = INITIAL_RECONNECT_DELAY_MS;
			}
			console.log(`[gateway-control] reconnecting in ${delayMs}ms`);
			await this.waitForReconnectDelay(delayMs);
			delayMs = Math.min(delayMs * 2, MAX_RECONNECT_DELAY_MS);
		}
	}

	async stop(): Promise<void> {
		this.stopping = true;
		this.socket?.close(1000, 'gateway shutting down');
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
			this.finishReconnectDelay?.();
		}
		await this.pendingCommand;
	}

	private connectOnce(): Promise<void> {
		return new Promise((resolve, reject) => {
			const socket = new WebSocket(this.url);
			this.socket = socket;
			let authenticated = false;
			let settled = false;
			let commandFailed = false;
			let heartbeatId = 0;
			let lastHeartbeatAckAt = Date.now();
			let heartbeatTimer: NodeJS.Timeout | undefined;
			const authTimeout = setTimeout(() => {
				finish(new Error('Timed out waiting for gateway control authentication'));
				socket.close(1008, 'authentication timed out');
			}, AUTHENTICATION_TIMEOUT_MS);

			const finish = (error?: Error): void => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(authTimeout);
				if (heartbeatTimer) {
					clearInterval(heartbeatTimer);
					heartbeatTimer = undefined;
				}
				if (this.socket === socket) {
					this.socket = undefined;
				}
				if (error) {
					reject(error);
				} else {
					resolve();
				}
			};

			socket.addEventListener('open', () => {
				if (this.stopping) {
					socket.close(1000, 'gateway shutting down');
					return;
				}
				socket.send(JSON.stringify({ type: 'authenticate', token: this.token }));
			});

			socket.addEventListener('message', (event) => {
				void readMessage(event.data)
					.then((message) => {
						if (message.type === 'authenticated') {
							if (authenticated) {
								throw new Error('Gateway control authenticated more than once');
							}
							authenticated = true;
							clearTimeout(authTimeout);
							heartbeatTimer = setInterval(() => {
								if (Date.now() - lastHeartbeatAckAt >= HEARTBEAT_TIMEOUT_MS) {
									console.warn('[gateway-control] heartbeat timed out; reconnecting');
									finish();
									socket.close(1011, 'Gateway control heartbeat timed out');
									return;
								}
								if (socket.readyState === WebSocket.OPEN) {
									try {
										socket.send(JSON.stringify({ type: 'heartbeat', heartbeatId: String(++heartbeatId) }));
									} catch {
										finish();
										socket.close(1011, 'Unable to send gateway control heartbeat');
									}
								}
							}, HEARTBEAT_INTERVAL_MS);
							console.log('[gateway-control] connected');
							return;
						}

						if (message.type === 'heartbeat_ack') {
							if (message.heartbeatId === String(heartbeatId)) {
								lastHeartbeatAckAt = Date.now();
							}
							return;
						}

						if (!authenticated) {
							throw new Error('Received a gateway command before authentication');
						}
						if (message.type !== 'command') {
							throw new Error('Gateway control returned an unsupported message');
						}
						if (this.stopping) {
							socket.close(1000, 'gateway shutting down');
							return;
						}

						this.pendingCommand = this.pendingCommand
							.then(async () => {
								if (commandFailed) {
									return;
								}
								console.log(`[gateway-control] command received: ${message.command.action} ${message.command.sessionId}`);
								await this.onCommand(message.command);
								if (socket.readyState === WebSocket.OPEN) {
									socket.send(JSON.stringify({ type: 'ack', commandId: message.command.commandId }));
									console.log(`[gateway-control] command acknowledged: ${message.command.action} ${message.command.sessionId}`);
								}
							})
							.catch((error: unknown) => {
								commandFailed = true;
								console.error('[gateway-control] command failed; leaving it unacknowledged', error);
								socket.close(1011, 'command handling failed');
							});
					})
					.catch((error: unknown) => {
						console.error('[gateway-control] invalid message', error instanceof Error ? error.message : error);
						socket.close(1003, 'invalid gateway control message');
					});
			});

			socket.addEventListener('error', () => {
				if (!authenticated) {
					finish(new Error('Gateway control WebSocket connection failed'));
					socket.close();
				}
			});

			socket.addEventListener('close', (event) => {
				console.log(`[gateway-control] disconnected (${event.code})`);
				finish(authenticated ? undefined : new Error('Gateway control closed before authentication'));
			});
		});
	}

	private waitForReconnectDelay(durationMs: number): Promise<void> {
		return new Promise((resolve) => {
			this.finishReconnectDelay = resolve;
			this.reconnectTimer = setTimeout(() => {
				this.reconnectTimer = undefined;
				this.finishReconnectDelay = undefined;
				resolve();
			}, durationMs);
		});
	}
}

async function readMessage(data: unknown): Promise<ControlMessage> {
	let text: string;
	if (typeof data === 'string') {
		text = data;
	} else if (data instanceof ArrayBuffer) {
		text = Buffer.from(data).toString('utf8');
	} else if (ArrayBuffer.isView(data)) {
		text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
	} else if (typeof Blob !== 'undefined' && data instanceof Blob) {
		text = await data.text();
	} else {
		throw new Error('Gateway control returned a non-text message');
	}

	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error('Gateway control returned invalid JSON');
	}
	if (!isRecord(value) || typeof value.type !== 'string') {
		throw new Error('Gateway control returned an invalid message');
	}
	if (value.type === 'authenticated') {
		return { type: 'authenticated' };
	}
	if (value.type === 'heartbeat_ack' && typeof value.heartbeatId === 'string') {
		return { type: 'heartbeat_ack', heartbeatId: value.heartbeatId };
	}
	if (value.type === 'command' && isGatewayCommand(value.command)) {
		return { type: 'command', command: value.command };
	}
	throw new Error('Gateway control returned an unsupported message');
}

function isGatewayCommand(value: unknown): value is GatewayCommand {
	if (!isRecord(value)) {
		return false;
	}
	const hasSessionIdentity =
		typeof value.commandId === 'string' &&
		(SNOWFLAKE_PATTERN.test(value.commandId) || UUID_PATTERN.test(value.commandId)) &&
		typeof value.guildId === 'string' &&
		SNOWFLAKE_PATTERN.test(value.guildId) &&
		typeof value.channelId === 'string' &&
		SNOWFLAKE_PATTERN.test(value.channelId) &&
		typeof value.sessionId === 'string' &&
		UUID_PATTERN.test(value.sessionId);
	if (!hasSessionIdentity) {
		return false;
	}
	if (value.action === 'start' || value.action === 'stop') {
		return true;
	}
	return (
		value.action === 'imakita' &&
		typeof value.applicationId === 'string' &&
		SNOWFLAKE_PATTERN.test(value.applicationId) &&
		typeof value.interactionToken === 'string' &&
		value.interactionToken.length > 0 &&
		value.interactionToken.length <= 1024
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
