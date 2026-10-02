import { EndBehaviorType, type AudioReceiveStream, type VoiceReceiver } from '@discordjs/voice';
import Prism from 'prism-media';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StreamAudioEncoder } from '../audio/stream-audio-encoder.ts';
const stereoAudioFormat = { sampleRate: 48_000, channels: 2, frameSamples: 960 };
type VoiceReceiveStats = { framesReceived: number; bytesReceived: number };

const FRAME_BYTES = stereoAudioFormat.frameSamples * stereoAudioFormat.channels * 2;
const FRAME_DURATION_MS = (stereoAudioFormat.frameSamples / stereoAudioFormat.sampleRate) * 1000;

type ActiveUserStream = {
	stream: AudioReceiveStream;
	decoder: Prism.opus.Decoder;
	firstFrameIndex: number;
	pending: Buffer;
	userId: string;
	encoder: StreamAudioEncoder;
};

export type VoiceRecordingResult = {
	sessionId: string;
	sessionDir: string;
	startedAt: string;
	endedAt: string;
	durationMs: number;
	format: typeof stereoAudioFormat;
	stats: VoiceReceiveStats;
};

export class VoiceRecorder {
	private readonly stats: VoiceReceiveStats = { framesReceived: 0, bytesReceived: 0 };
	private readonly activeStreams = new Map<string, ActiveUserStream>();
	private readonly startedAt = Date.now();
	private acceptingAudio = true;
	private stopped = false;
	private failure: Error | undefined;
	private silenceTimer: NodeJS.Timeout | undefined;

	private constructor(
		private readonly receiver: VoiceReceiver,
		private readonly sessionId: string,
		private readonly outputDir: string,
		private readonly onAsrAudio?: (speakerId: string, startMs: number, pcm: Buffer) => void,
		private readonly onSilenceTick?: (elapsedMs: number) => void,
	) {}

	static async create(
		receiver: VoiceReceiver,
		outputDir: string,
		sessionId: string,
		onAsrAudio?: (speakerId: string, startMs: number, pcm: Buffer) => void,
		onSilenceTick?: (elapsedMs: number) => void,
	): Promise<VoiceRecorder> {
		const sessionDir = join(outputDir, sessionId);
		await mkdir(sessionDir, { recursive: true });
		return new VoiceRecorder(receiver, sessionId, sessionDir, onAsrAudio, onSilenceTick);
	}

	start(): void {
		this.receiver.speaking.on('start', this.handleSpeakingStart);
		this.silenceTimer = setInterval(() => this.onSilenceTick?.(Date.now() - this.startedAt), 250);
		this.silenceTimer.unref();
	}

	private readonly handleSpeakingStart = (userId: string): void => {
		if (!this.acceptingAudio || this.activeStreams.has(userId)) {
			return;
		}

		const stream = this.receiver.subscribe(userId, {
			end: {
				behavior: EndBehaviorType.AfterSilence,
				duration: 100,
			},
		});
		const decoder = new Prism.opus.Decoder({
			frameSize: stereoAudioFormat.frameSamples,
			channels: stereoAudioFormat.channels,
			rate: stereoAudioFormat.sampleRate,
		});
		const activeStream: ActiveUserStream = {
			stream,
			decoder,
			firstFrameIndex: this.elapsedFrameIndex,
			pending: Buffer.alloc(0),
			userId,
			encoder: new StreamAudioEncoder(),
		};

		this.activeStreams.set(userId, activeStream);
		stream.pipe(decoder);
		decoder.on('data', (chunk: Buffer) => this.handleDecodedPcm(activeStream, chunk));
		decoder.once('end', () => this.cleanupStream(userId, activeStream));
		decoder.once('error', (error) => {
			console.error(`[voice] Opus decode failed for user ${userId}`, error);
			this.failure ??= error;
			this.cleanupStream(userId, activeStream);
		});
		stream.once('error', (error) => {
			console.error(`[voice] audio receive failed for user ${userId}`, error);
			this.failure ??= error;
			decoder.destroy(error);
		});
	};

	private handleDecodedPcm(activeStream: ActiveUserStream, chunk: Buffer): void {
		if (!this.acceptingAudio) {
			return;
		}

		const pcm = activeStream.pending.length > 0 ? Buffer.concat([activeStream.pending, chunk]) : chunk;
		const completeLength = pcm.length - (pcm.length % FRAME_BYTES);
		if (completeLength > 0) {
			this.stats.framesReceived += completeLength / FRAME_BYTES;
			this.stats.bytesReceived += completeLength;
			for (let offset = 0; offset < completeLength; offset += FRAME_BYTES) {
				this.onAsrAudio?.(
					activeStream.userId,
					activeStream.firstFrameIndex * FRAME_DURATION_MS,
					activeStream.encoder.encode48kStereoPcm16le(pcm.subarray(offset, offset + FRAME_BYTES)),
				);
				activeStream.firstFrameIndex += 1;
			}
		}
		activeStream.pending = pcm.subarray(completeLength);
	}

	private cleanupStream(userId: string, activeStream: ActiveUserStream): void {
		if (this.activeStreams.get(userId) === activeStream) {
			this.activeStreams.delete(userId);
		}
	}

	async stop(): Promise<VoiceRecordingResult> {
		if (this.stopped) {
			throw new Error('Voice recorder has already stopped');
		}
		this.stopped = true;
		this.acceptingAudio = false;
		clearInterval(this.silenceTimer);
		this.receiver.speaking.off('start', this.handleSpeakingStart);

		for (const activeStream of this.activeStreams.values()) {
			activeStream.stream.destroy();
			activeStream.decoder.destroy();
		}
		this.activeStreams.clear();

		const endedAt = new Date();
		const result: VoiceRecordingResult = {
			sessionId: this.sessionId,
			sessionDir: this.outputDir,
			startedAt: new Date(this.startedAt).toISOString(),
			endedAt: endedAt.toISOString(),
			durationMs: endedAt.getTime() - this.startedAt,
			format: stereoAudioFormat,
			stats: this.stats,
		};

		const manifest = {
			sessionId: result.sessionId,
			startedAt: result.startedAt,
			endedAt: result.endedAt,
			durationMs: result.durationMs,
			format: result.format,
			stats: result.stats,
		};
		await writeFile(join(this.outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
		if (this.failure) throw this.failure;
		return result;
	}

	private get elapsedFrameIndex(): number {
		return Math.floor((Date.now() - this.startedAt) / FRAME_DURATION_MS);
	}
}
