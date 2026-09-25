import { EndBehaviorType, type AudioReceiveStream, type VoiceReceiver } from '@discordjs/voice';
import Prism from 'prism-media';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StereoPcmMixer, stereoAudioFormat, type StereoMixerStats } from '../audio/stereo-mixer.js';

const FRAME_BYTES = stereoAudioFormat.frameSamples * stereoAudioFormat.channels * 2;
const FRAME_DURATION_MS = (stereoAudioFormat.frameSamples / stereoAudioFormat.sampleRate) * 1000;

type ActiveUserStream = {
	stream: AudioReceiveStream;
	decoder: Prism.opus.Decoder;
	firstFrameIndex: number;
	pending: Buffer;
};

export type VoiceRecordingResult = {
	sessionId: string;
	filePath: string;
	startedAt: string;
	endedAt: string;
	durationMs: number;
	format: typeof stereoAudioFormat;
	stats: StereoMixerStats;
};

export class VoiceRecorder {
	private readonly activeStreams = new Map<string, ActiveUserStream>();
	private readonly startedAt = Date.now();
	private acceptingAudio = true;
	private stopped = false;

	private constructor(
		private readonly receiver: VoiceReceiver,
		private readonly mixer: StereoPcmMixer,
		private readonly sessionId: string,
		private readonly outputDir: string,
	) {}

	static async create(receiver: VoiceReceiver, outputDir: string, sessionId: string): Promise<VoiceRecorder> {
		const sessionDir = join(outputDir, sessionId);
		await mkdir(sessionDir, { recursive: true });
		const mixer = await StereoPcmMixer.create(join(sessionDir, 'mixed-48khz-stereo.wav'));
		return new VoiceRecorder(receiver, mixer, sessionId, sessionDir);
	}

	start(): void {
		this.receiver.speaking.on('start', this.handleSpeakingStart);
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
		};

		this.activeStreams.set(userId, activeStream);
		stream.pipe(decoder);
		decoder.on('data', (chunk: Buffer) => this.handleDecodedPcm(activeStream, chunk));
		decoder.once('end', () => this.cleanupStream(userId, activeStream));
		decoder.once('error', (error) => {
			console.error(`[voice] Opus decode failed for user ${userId}`, error);
			this.cleanupStream(userId, activeStream);
		});
		stream.once('error', (error) => {
			console.error(`[voice] audio receive failed for user ${userId}`, error);
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
			this.mixer.addPcm(activeStream.firstFrameIndex, pcm.subarray(0, completeLength));
			activeStream.firstFrameIndex += completeLength / FRAME_BYTES;
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
		this.receiver.speaking.off('start', this.handleSpeakingStart);

		for (const activeStream of this.activeStreams.values()) {
			activeStream.stream.destroy();
			activeStream.decoder.destroy();
		}
		this.activeStreams.clear();

		const stats = await this.mixer.close();
		const endedAt = new Date();
		const result: VoiceRecordingResult = {
			sessionId: this.sessionId,
			filePath: join(this.outputDir, 'mixed-48khz-stereo.wav'),
			startedAt: new Date(this.startedAt).toISOString(),
			endedAt: endedAt.toISOString(),
			durationMs: endedAt.getTime() - this.startedAt,
			format: stereoAudioFormat,
			stats,
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
		return result;
	}

	private get elapsedFrameIndex(): number {
		return Math.floor((Date.now() - this.startedAt) / FRAME_DURATION_MS);
	}
}
