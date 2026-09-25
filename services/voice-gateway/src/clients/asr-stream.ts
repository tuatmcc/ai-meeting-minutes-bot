import type { AsrTranscription } from './asr-api.ts';

const SAMPLE_RATE = 16_000;
const CHUNK_SECONDS = 2;
const CHUNK_BYTES = SAMPLE_RATE * CHUNK_SECONDS * 4;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const CONNECT_TIMEOUT_MS = 15_000;
const FINAL_TIMEOUT_MS = 120_000;

type StreamMessage = {
	type: string;
	model?: unknown;
	language?: unknown;
	text?: unknown;
	detail?: unknown;
	sample_rate?: unknown;
};

export class AsrStream {
	private readonly socket: WebSocket;
	private readonly readyPromise: Promise<void>;
	private resolveReady!: () => void;
	private rejectReady!: (error: Error) => void;
	private resolveFinal?: (result: AsrTranscription) => void;
	private rejectFinal?: (error: Error) => void;
	private pendingAudio = Buffer.alloc(0);
	private failure: Error | undefined;
	private finalResultReceived = false;
	private finished = false;
	private latestResult: AsrTranscription = { model: '', language: null, text: '' };

	private constructor(
		asrApiUrl: string,
		private readonly onPartial?: (result: AsrTranscription) => void,
	) {
		const streamUrl = new URL('stream', asrApiUrl.endsWith('/') ? asrApiUrl : `${asrApiUrl}/`);
		streamUrl.protocol = streamUrl.protocol === 'https:' ? 'wss:' : 'ws:';
		this.socket = new WebSocket(streamUrl);
		this.readyPromise = new Promise<void>((resolve, reject) => {
			this.resolveReady = resolve;
			this.rejectReady = reject;
		});

		this.socket.addEventListener('open', () => {
			this.socket.send(JSON.stringify({ type: 'start', language: 'Japanese', sample_rate: SAMPLE_RATE }));
		});
		this.socket.addEventListener('message', (event) => this.handleMessage(event.data));
		this.socket.addEventListener('error', () => this.fail(new Error('ASR WebSocket connection failed')));
		this.socket.addEventListener('close', () => {
			if (!this.finalResultReceived) {
				this.fail(new Error('ASR WebSocket closed before returning a final transcription'));
			}
		});
	}

	static async connect(asrApiUrl: string, onPartial?: (result: AsrTranscription) => void): Promise<AsrStream> {
		const stream = new AsrStream(asrApiUrl, onPartial);
		let timeout: NodeJS.Timeout | undefined;
		try {
			await Promise.race([
				stream.readyPromise,
				new Promise<never>((_, reject) => {
					timeout = setTimeout(() => reject(new Error('Timed out waiting for ASR WebSocket readiness')), CONNECT_TIMEOUT_MS);
				}),
			]);
			return stream;
		} catch (error) {
			stream.abort();
			throw error;
		} finally {
			if (timeout) {
				clearTimeout(timeout);
			}
		}
	}

	sendAudio(float32MonoPcm: Buffer): void {
		if (this.failure || this.finished || float32MonoPcm.length === 0) {
			return;
		}
		if (float32MonoPcm.length % 4 !== 0) {
			this.fail(new Error('ASR audio must contain float32 samples'));
			return;
		}
		if (this.socket.readyState !== WebSocket.OPEN) {
			this.fail(new Error('ASR WebSocket is not open while recording'));
			return;
		}

		this.pendingAudio = Buffer.concat([this.pendingAudio, float32MonoPcm]);
		while (this.pendingAudio.length >= CHUNK_BYTES) {
			if (this.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
				this.fail(new Error('ASR WebSocket is falling behind the live audio stream'));
				return;
			}
			this.socket.send(this.pendingAudio.subarray(0, CHUNK_BYTES));
			this.pendingAudio = this.pendingAudio.subarray(CHUNK_BYTES);
		}
	}

	async finish(): Promise<AsrTranscription> {
		await this.readyPromise;
		if (this.failure) {
			throw this.failure;
		}
		if (this.finished) {
			return this.latestResult;
		}
		this.finished = true;

		const finalPromise = new Promise<AsrTranscription>((resolve, reject) => {
			this.resolveFinal = resolve;
			this.rejectFinal = reject;
		});

		let timeout: NodeJS.Timeout | undefined;
		try {
			if (this.pendingAudio.length > 0) {
				this.socket.send(this.pendingAudio);
				this.pendingAudio = Buffer.alloc(0);
			}
			this.socket.send(JSON.stringify({ type: 'stop' }));
			return await Promise.race([
				finalPromise,
				new Promise<never>((_, reject) => {
					timeout = setTimeout(() => reject(new Error('Timed out waiting for final ASR transcription')), FINAL_TIMEOUT_MS);
				}),
			]);
		} finally {
			if (timeout) {
				clearTimeout(timeout);
			}
			this.socket.close();
		}
	}

	abort(): void {
		this.finished = true;
		this.socket.close();
	}

	private handleMessage(data: unknown): void {
		let message: StreamMessage;
		try {
			const text = typeof data === 'string' ? data : Buffer.from(data as ArrayBuffer).toString('utf8');
			message = JSON.parse(text) as StreamMessage;
		} catch {
			this.fail(new Error('ASR WebSocket returned an invalid message'));
			return;
		}

		if (message.type === 'error') {
			this.fail(new Error(typeof message.detail === 'string' ? message.detail : 'ASR stream failed'));
			return;
		}
		if (message.type === 'ready') {
			if (message.sample_rate !== SAMPLE_RATE) {
				this.fail(new Error('ASR WebSocket negotiated an unexpected sample rate'));
				return;
			}
			this.resolveReady();
			return;
		}
		if (message.type === 'partial' || message.type === 'final') {
			const result = toTranscription(message);
			if (!result) {
				this.fail(new Error('ASR WebSocket returned an invalid transcription'));
				return;
			}
			this.latestResult = result;
			if (message.type === 'partial') {
				try {
					this.onPartial?.(result);
				} catch (error) {
					console.error('[asr] partial transcription handler failed', error);
				}
			} else {
				this.finalResultReceived = true;
				this.resolveFinal?.(result);
			}
		}
	}

	private fail(error: Error): void {
		this.failure ??= error;
		this.rejectReady(error);
		this.rejectFinal?.(error);
	}
}

function toTranscription(value: StreamMessage): AsrTranscription | undefined {
	if (
		typeof value.model !== 'string' ||
		(value.language !== null && typeof value.language !== 'string') ||
		typeof value.text !== 'string'
	) {
		return undefined;
	}
	return { model: value.model, language: value.language, text: value.text };
}
