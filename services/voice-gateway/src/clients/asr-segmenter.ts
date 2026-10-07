import { appendFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AsrApi, AsrSegmentMetadata, AsrSession, AsrTranscription } from './asr-api.ts';

const SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 4;
const MAX_SAMPLES = SAMPLE_RATE * 60;
const MIN_SAMPLES = SAMPLE_RATE * 10;
const SILENCE_MS = 1500;
const MAX_SPEAKERS = 32;
const MAX_QUEUED_SEGMENTS = 32;

type SpeakerBuffer = { startSample: number; endSample: number; parts: Buffer[] };
type PendingSegment = AsrSegmentMetadata & { audio: Buffer; persisted: Promise<void> };
export type AsrTranscriptSegment = AsrSegmentMetadata & AsrTranscription;
export type MeetingTranscription = AsrTranscription & { segments: AsrTranscriptSegment[] };

export class AsrSegmenter {
	private readonly speakers = new Map<string, SpeakerBuffer>();
	private readonly queue: PendingSegment[] = [];
	private readonly completedSegments: AsrTranscriptSegment[] = [];
	private nextSegmentIndex: number;
	private readonly timeOffsetMs: number;
	private workerPromise: Promise<void> | undefined;
	private failure: Error | undefined;
	private finished = false;
	private finalResult: MeetingTranscription | undefined;

	private readonly asrApi: Pick<AsrApi, 'transcribeWav'>;
	private readonly recordingDir: string;
	private readonly session: AsrSession;

	constructor(
		asrApi: Pick<AsrApi, 'transcribeWav'>,
		recordingDir: string,
		session: AsrSession,
		resume: { segmentIndexOffset: number; timeOffsetMs: number } = { segmentIndexOffset: 0, timeOffsetMs: 0 },
	) {
		this.asrApi = asrApi;
		this.recordingDir = recordingDir;
		this.session = session;
		this.nextSegmentIndex = resume.segmentIndexOffset;
		this.timeOffsetMs = resume.timeOffsetMs;
	}

	addAudio(speakerId: string, startMs: number, pcm: Buffer): void {
		if (this.finished || this.failure || pcm.length === 0) return;
		if (pcm.length % BYTES_PER_SAMPLE !== 0 || !Number.isFinite(startMs) || startMs < 0) {
			this.fail(new Error('Invalid speaker audio frame'));
			return;
		}
		// Discord can deliver silence packets continuously, so packet absence alone is insufficient.
		let energy = 0;
		for (let offset = 0; offset < pcm.length; offset += BYTES_PER_SAMPLE) energy += pcm.readFloatLE(offset) ** 2;
		if (Math.sqrt(energy / (pcm.length / BYTES_PER_SAMPLE)) < 0.003) return;

		let startSample = Math.round(((startMs + this.timeOffsetMs) * SAMPLE_RATE) / 1000);
		let remaining = pcm;
		while (remaining.length > 0 && !this.failure) {
			let buffer = this.speakers.get(speakerId);
			if (buffer && startSample - buffer.startSample >= MAX_SAMPLES) {
				this.flush(speakerId);
				buffer = undefined;
			}
			if (!buffer) {
				if (this.speakers.size >= MAX_SPEAKERS) {
					this.fail(new Error('Too many simultaneous speaker buffers'));
					return;
				}
				buffer = { startSample, endSample: startSample, parts: [] };
				this.speakers.set(speakerId, buffer);
			}
			if (startSample < buffer.endSample) {
				const overlapBytes = Math.min(remaining.length, (buffer.endSample - startSample) * BYTES_PER_SAMPLE);
				remaining = remaining.subarray(overlapBytes);
				startSample += overlapBytes / BYTES_PER_SAMPLE;
				if (remaining.length === 0) break;
			}
			const gap = startSample - buffer.endSample;
			if (gap > 0) buffer.parts.push(Buffer.alloc(gap * BYTES_PER_SAMPLE));
			const samples = Math.min(remaining.length / BYTES_PER_SAMPLE, MAX_SAMPLES - (startSample - buffer.startSample));
			buffer.parts.push(Buffer.from(remaining.subarray(0, samples * BYTES_PER_SAMPLE)));
			buffer.endSample = startSample + samples;
			remaining = remaining.subarray(samples * BYTES_PER_SAMPLE);
			startSample += samples;
			if (buffer.endSample - buffer.startSample >= MAX_SAMPLES) this.flush(speakerId);
		}
	}

	flushSilent(elapsedMs: number): void {
		if (this.finished || this.failure) return;
		for (const [speakerId, buffer] of this.speakers) {
			const meetingElapsedMs = elapsedMs + this.timeOffsetMs;
			const ready = buffer.endSample - buffer.startSample >= MIN_SAMPLES || meetingElapsedMs - samplesToMs(buffer.startSample) >= 60_000;
			if (ready && meetingElapsedMs - samplesToMs(buffer.endSample) >= SILENCE_MS) this.flush(speakerId);
		}
	}

	async finish(): Promise<MeetingTranscription> {
		if (this.finalResult) return this.finalResult;
		this.finished = true;
		for (const speakerId of this.speakers.keys()) this.flush(speakerId);
		while (this.workerPromise) await this.workerPromise;
		if (this.failure) throw this.failure;
		const segments = this.sortedSegments();
		this.finalResult = {
			model: segments[0]?.model ?? '',
			language: segments.find((segment) => segment.language)?.language ?? null,
			text: formatTranscript(segments),
			segments,
		};
		return this.finalResult;
	}

	getSnapshot(): string {
		return formatTranscript(this.sortedSegments());
	}

	private sortedSegments(): AsrTranscriptSegment[] {
		return [...this.completedSegments].sort((a, b) => a.startMs - b.startMs || a.index - b.index);
	}

	private flush(speakerId: string): void {
		const buffer = this.speakers.get(speakerId);
		if (!buffer) return;
		this.speakers.delete(speakerId);
		const segment = {
			index: this.nextSegmentIndex++,
			speakerId,
			startMs: samplesToMs(buffer.startSample),
			endMs: samplesToMs(buffer.endSample),
			audio: encodePcm16Wav(Buffer.concat(buffer.parts)),
		};
		if (this.queue.length >= MAX_QUEUED_SEGMENTS && !this.finished) this.fail(new Error('ASR is falling behind the live audio stream'));
		// Retain the triggering chunk and all buffered tails on disk even after a failure.
		const { audio, ...metadata } = segment;
		const prefix = this.pendingPrefix(metadata.index);
		const persisted = (async () => {
			await writeFile(`${prefix}.wav`, audio);
			await writeFile(`${prefix}.json`, `${JSON.stringify({ ...this.session, ...metadata })}\n`);
		})().catch((error: unknown) => this.fail(error instanceof Error ? error : new Error(String(error))));
		this.queue.push({ ...segment, persisted });
		if (!this.workerPromise) {
			this.workerPromise = this.processQueue().finally(() => {
				this.workerPromise = undefined;
			});
		}
	}

	private async processQueue(): Promise<void> {
		while (this.queue.length > 0) {
			const { audio, persisted, ...metadata } = this.queue.shift()!;
			const prefix = this.pendingPrefix(metadata.index);
			try {
				await persisted;
				if (this.failure) continue;
				const transcription = await this.asrApi.transcribeWav(this.session, audio, metadata);
				const result = { ...metadata, ...transcription };
				await appendFile(join(this.recordingDir, 'transcription-segments.jsonl'), `${JSON.stringify(result)}\n`, 'utf8');
				this.completedSegments.push(result);
				await rm(`${prefix}.wav`);
				await rm(`${prefix}.json`);
				console.log(`[transcription] speaker ${metadata.speakerId} segment ${metadata.index} saved`);
			} catch (error) {
				this.fail(error instanceof Error ? error : new Error(String(error)));
			}
		}
	}

	private pendingPrefix(index: number): string {
		return join(this.recordingDir, `pending-${String(index).padStart(6, '0')}`);
	}

	private fail(error: Error): void {
		if (this.failure) return;
		this.failure = error;
		console.error('[transcription] segment processing failed', error);
	}
}

function formatTranscript(segments: AsrTranscriptSegment[]): string {
	return segments
		.filter((segment) => segment.text.trim())
		.map((segment) => {
			const seconds = Math.floor(segment.startMs / 1000);
			const timestamp = `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
			return `[${timestamp}] speaker=${segment.speakerId}: ${segment.text}`;
		})
		.join('\n');
}

function encodePcm16Wav(pcm: Buffer): Buffer {
	const sampleCount = pcm.length / BYTES_PER_SAMPLE;
	const wav = Buffer.alloc(44 + sampleCount * 2);
	wav.write('RIFF', 0);
	wav.writeUInt32LE(wav.length - 8, 4);
	wav.write('WAVE', 8);
	wav.write('fmt ', 12);
	wav.writeUInt32LE(16, 16);
	wav.writeUInt16LE(1, 20);
	wav.writeUInt16LE(1, 22);
	wav.writeUInt32LE(SAMPLE_RATE, 24);
	wav.writeUInt32LE(SAMPLE_RATE * 2, 28);
	wav.writeUInt16LE(2, 32);
	wav.writeUInt16LE(16, 34);
	wav.write('data', 36);
	wav.writeUInt32LE(sampleCount * 2, 40);
	for (let index = 0; index < sampleCount; index++) {
		const sample = Math.max(-1, Math.min(1, pcm.readFloatLE(index * BYTES_PER_SAMPLE)));
		wav.writeInt16LE(Math.round(sample < 0 ? sample * 32768 : sample * 32767), 44 + index * 2);
	}
	return wav;
}

function samplesToMs(samples: number): number {
	return Math.round((samples / SAMPLE_RATE) * 1000);
}
