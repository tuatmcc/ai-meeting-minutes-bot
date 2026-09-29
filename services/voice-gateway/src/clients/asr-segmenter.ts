import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AsrApi, AsrTranscription } from './asr-api.ts';

const SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 4;
const SEGMENT_SECONDS = 30;
const OVERLAP_SECONDS = 2;
const SEGMENT_BYTES = SAMPLE_RATE * SEGMENT_SECONDS * BYTES_PER_SAMPLE;
const OVERLAP_BYTES = SAMPLE_RATE * OVERLAP_SECONDS * BYTES_PER_SAMPLE;
const MAX_QUEUED_SEGMENTS = 2;
const MIN_TEXT_OVERLAP_CHARS = 6;
const MAX_TEXT_OVERLAP_CHARS = 256;

type PendingSegment = {
	index: number;
	startSample: number;
	audio: Buffer;
};

export type AsrTranscriptSegment = {
	index: number;
	startMs: number;
	endMs: number;
	model: string;
	language: string | null;
	text: string;
};

export type MeetingTranscription = AsrTranscription & {
	segments: AsrTranscriptSegment[];
};

export class AsrSegmenter {
	private readonly checkpointPath: string;
	private readonly bufferedAudio: Buffer[] = [];
	private bufferedBytes = 0;
	private nextSegmentIndex = 0;
	private nextStartSample = 0;
	private readonly queue: PendingSegment[] = [];
	private readonly completedSegments: AsrTranscriptSegment[] = [];
	private workerPromise: Promise<void> | undefined;
	private failure: Error | undefined;
	private finished = false;
	private finalResult: MeetingTranscription | undefined;

	constructor(
		private readonly asrApi: AsrApi,
		recordingDir: string,
	) {
		this.checkpointPath = join(recordingDir, 'transcription-segments.jsonl');
	}

	addAudio(float32MonoPcm: Buffer): void {
		if (this.finished || this.failure || float32MonoPcm.length === 0) {
			return;
		}
		if (float32MonoPcm.length % BYTES_PER_SAMPLE !== 0) {
			this.fail(new Error('ASR audio must contain float32 samples'));
			return;
		}

		this.bufferedAudio.push(float32MonoPcm);
		this.bufferedBytes += float32MonoPcm.length;
		while (this.bufferedBytes >= SEGMENT_BYTES && !this.failure) {
			const audio = this.takeBufferedAudio(SEGMENT_BYTES);
			this.enqueue({ index: this.nextSegmentIndex, startSample: this.nextStartSample, audio });
			if (this.failure) {
				break;
			}
			this.nextSegmentIndex += 1;
			this.nextStartSample += SAMPLE_RATE * (SEGMENT_SECONDS - OVERLAP_SECONDS);
			this.bufferedAudio.unshift(Buffer.from(audio.subarray(audio.length - OVERLAP_BYTES)));
			this.bufferedBytes += OVERLAP_BYTES;
		}
	}

	async finish(): Promise<MeetingTranscription> {
		if (this.finalResult) {
			return this.finalResult;
		}
		this.finished = true;

		const minimumTailBytes = this.nextSegmentIndex === 0 ? 1 : OVERLAP_BYTES + 1;
		if (!this.failure && this.bufferedBytes >= minimumTailBytes) {
			const audio = this.takeBufferedAudio(this.bufferedBytes);
			this.enqueue({ index: this.nextSegmentIndex, startSample: this.nextStartSample, audio });
			this.nextSegmentIndex += 1;
		}

		while (this.workerPromise) {
			await this.workerPromise;
		}
		if (this.failure) {
			throw this.failure;
		}

		let text = '';
		for (const segment of this.completedSegments) {
			text = mergeTranscriptText(text, segment.text);
		}
		this.finalResult = {
			model: this.completedSegments[0]?.model ?? '',
			language: this.completedSegments.find((segment) => segment.language)?.language ?? null,
			text,
			segments: this.completedSegments,
		};
		return this.finalResult;
	}

	getSnapshot(): string {
		return this.completedSegments.reduce((text, segment) => mergeTranscriptText(text, segment.text), '');
	}

	private enqueue(segment: PendingSegment): void {
		if (this.failure) {
			return;
		}
		if (this.queue.length >= MAX_QUEUED_SEGMENTS) {
			this.fail(new Error('ASR is falling behind the live audio stream'));
			return;
		}
		this.queue.push(segment);
		this.startWorker();
	}

	private startWorker(): void {
		if (this.workerPromise) {
			return;
		}
		this.workerPromise = this.processQueue().finally(() => {
			this.workerPromise = undefined;
			if (this.queue.length > 0 && !this.failure) {
				this.startWorker();
			}
		});
	}

	private async processQueue(): Promise<void> {
		while (this.queue.length > 0 && !this.failure) {
			const segment = this.queue.shift()!;
			try {
				const transcription = await this.asrApi.transcribeWav(
					encodePcm16Wav(segment.audio),
					`segment-${String(segment.index + 1).padStart(4, '0')}.wav`,
				);
				const result: AsrTranscriptSegment = {
					index: segment.index,
					startMs: samplesToMs(segment.startSample),
					endMs: samplesToMs(segment.startSample + segment.audio.length / BYTES_PER_SAMPLE),
					model: transcription.model,
					language: transcription.language,
					text: transcription.text,
				};
				await appendFile(this.checkpointPath, `${JSON.stringify(result)}\n`, 'utf8');
				this.completedSegments.push(result);
				console.log(`[transcription] segment ${result.index + 1} saved (${result.startMs}-${result.endMs}ms)`);
			} catch (error) {
				this.fail(error instanceof Error ? error : new Error(String(error)));
			}
		}
	}

	private takeBufferedAudio(byteLength: number): Buffer {
		const parts: Buffer[] = [];
		let bytesToTake = byteLength;
		while (bytesToTake > 0) {
			const part = this.bufferedAudio.shift();
			if (!part) {
				throw new Error('ASR audio buffer ended unexpectedly');
			}
			if (part.length <= bytesToTake) {
				parts.push(part);
				bytesToTake -= part.length;
			} else {
				parts.push(part.subarray(0, bytesToTake));
				this.bufferedAudio.unshift(part.subarray(bytesToTake));
				bytesToTake = 0;
			}
		}
		this.bufferedBytes -= byteLength;
		return Buffer.concat(parts, byteLength);
	}

	private fail(error: Error): void {
		if (this.failure) {
			return;
		}
		this.failure = error;
		this.queue.length = 0;
		this.bufferedAudio.length = 0;
		this.bufferedBytes = 0;
		console.error('[transcription] segment processing failed', error);
	}
}

function encodePcm16Wav(float32MonoPcm: Buffer): Buffer {
	const sampleCount = float32MonoPcm.length / BYTES_PER_SAMPLE;
	const dataBytes = sampleCount * 2;
	const wav = Buffer.allocUnsafe(44 + dataBytes);
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
	wav.writeUInt32LE(dataBytes, 40);
	for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
		const sample = Math.max(-1, Math.min(1, float32MonoPcm.readFloatLE(sampleIndex * BYTES_PER_SAMPLE)));
		const pcm16 = Math.round(sample < 0 ? sample * 32_768 : sample * 32_767);
		wav.writeInt16LE(pcm16, 44 + sampleIndex * 2);
	}
	return wav;
}

function mergeTranscriptText(previousText: string, nextText: string): string {
	if (!previousText) {
		return nextText;
	}
	const previous = comparableCharacters(previousText);
	const next = comparableCharacters(nextText);
	const maxOverlap = Math.min(previous.length, next.length, MAX_TEXT_OVERLAP_CHARS);
	for (let overlapLength = maxOverlap; overlapLength >= MIN_TEXT_OVERLAP_CHARS; overlapLength -= 1) {
		let matches = true;
		for (let index = 0; index < overlapLength; index += 1) {
			if (previous[previous.length - overlapLength + index]?.character !== next[index]?.character) {
				matches = false;
				break;
			}
		}
		if (matches) {
			let trimThrough = next[overlapLength - 1]!.sourceIndex + 1;
			while (trimThrough < nextText.length && /[\p{P}\p{Z}\s]/u.test(nextText[trimThrough]!)) {
				trimThrough += 1;
			}
			return previousText + nextText.slice(trimThrough);
		}
	}
	return previousText + nextText;
}

function comparableCharacters(text: string): Array<{ character: string; sourceIndex: number }> {
	const characters: Array<{ character: string; sourceIndex: number }> = [];
	let sourceIndex = 0;
	for (const character of text) {
		if (!/[\p{P}\p{Z}\s]/u.test(character)) {
			characters.push({ character, sourceIndex });
		}
		sourceIndex += character.length;
	}
	return characters;
}

function samplesToMs(samples: number): number {
	return Math.round((samples / SAMPLE_RATE) * 1000);
}
