import { WavWriter } from './wav-writer.js';

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const FRAME_SAMPLES = 960;
const FRAME_DURATION_MS = (FRAME_SAMPLES / SAMPLE_RATE) * 1000;
const FRAME_BYTES = FRAME_SAMPLES * CHANNELS * 2;
const JITTER_BUFFER_FRAMES = 5;

type FrameSlot = {
	sum: Int32Array;
	count: number;
};

export type StereoMixerStats = {
	framesWritten: number;
	lateFramesDropped: number;
	bytesWritten: number;
};

export class StereoPcmMixer {
	private readonly frames = new Map<number, FrameSlot>();
	private readonly startedAt = Date.now();
	private readonly timer: NodeJS.Timeout;
	private nextFrameToFlush = 0;
	private lateFramesDropped = 0;
	private closed = false;

	private constructor(private readonly writer: WavWriter) {
		this.timer = setInterval(() => this.flushByClock(), FRAME_DURATION_MS);
		this.timer.unref();
	}

	static async create(filePath: string): Promise<StereoPcmMixer> {
		const writer = await WavWriter.create({
			filePath,
			sampleRate: SAMPLE_RATE,
			channels: CHANNELS,
			bitsPerSample: 16,
		});
		return new StereoPcmMixer(writer);
	}

	addPcm(firstFrameIndex: number, pcm: Buffer): void {
		if (this.closed) {
			return;
		}

		let offset = 0;
		let frameIndex = firstFrameIndex;
		while (offset + FRAME_BYTES <= pcm.length) {
			this.addFrame(frameIndex, pcm.subarray(offset, offset + FRAME_BYTES));
			offset += FRAME_BYTES;
			frameIndex += 1;
		}

		if (offset !== pcm.length) {
			throw new Error(`Decoded PCM is not aligned to ${FRAME_SAMPLES}-sample frames`);
		}
	}

	private addFrame(frameIndex: number, frame: Buffer): void {
		if (frameIndex < this.nextFrameToFlush) {
			this.lateFramesDropped += 1;
			return;
		}

		let slot = this.frames.get(frameIndex);
		if (!slot) {
			slot = { sum: new Int32Array(FRAME_SAMPLES * CHANNELS), count: 0 };
			this.frames.set(frameIndex, slot);
		}

		for (let sampleIndex = 0; sampleIndex < slot.sum.length; sampleIndex += 1) {
			slot.sum[sampleIndex] += frame.readInt16LE(sampleIndex * 2);
		}
		slot.count += 1;
	}

	private flushByClock(): void {
		const elapsedFrames = Math.floor((Date.now() - this.startedAt) / FRAME_DURATION_MS);
		this.flushThrough(elapsedFrames - JITTER_BUFFER_FRAMES);
	}

	private flushThrough(targetFrameIndex: number): void {
		while (this.nextFrameToFlush <= targetFrameIndex) {
			const slot = this.frames.get(this.nextFrameToFlush);
			const output = Buffer.alloc(FRAME_BYTES);

			if (slot) {
				for (let sampleIndex = 0; sampleIndex < slot.sum.length; sampleIndex += 1) {
					const mixed = Math.round(slot.sum[sampleIndex] / slot.count);
					const clipped = Math.max(-32768, Math.min(32767, mixed));
					output.writeInt16LE(clipped, sampleIndex * 2);
				}
				this.frames.delete(this.nextFrameToFlush);
			}

			this.writer.writePcm16le(output);
			this.nextFrameToFlush += 1;
		}
	}

	async close(): Promise<StereoMixerStats> {
		if (this.closed) {
			return this.stats;
		}
		this.closed = true;
		clearInterval(this.timer);

		const elapsedFrames = Math.ceil((Date.now() - this.startedAt) / FRAME_DURATION_MS);
		this.flushThrough(elapsedFrames - 1);
		await this.writer.close();

		return this.stats;
	}

	private get stats(): StereoMixerStats {
		return {
			framesWritten: this.nextFrameToFlush,
			lateFramesDropped: this.lateFramesDropped,
			bytesWritten: this.writer.bytesWritten,
		};
	}
}

export const stereoAudioFormat = {
	sampleRate: SAMPLE_RATE,
	channels: CHANNELS,
	frameSamples: FRAME_SAMPLES,
};
