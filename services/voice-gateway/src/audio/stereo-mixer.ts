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
	framesMixed: number;
	lateFramesDropped: number;
	bytesMixed: number;
};

export class StereoPcmMixer {
	private readonly frames = new Map<number, FrameSlot>();
	private readonly startedAt = Date.now();
	private readonly timer: NodeJS.Timeout;
	private nextFrameToFlush = 0;
	private lateFramesDropped = 0;
	private bytesMixed = 0;
	private closed = false;

	private constructor(private readonly onPcmFrame?: (frame: Buffer) => void) {
		this.timer = setInterval(() => this.flushByClock(), FRAME_DURATION_MS);
		this.timer.unref();
	}

	static create(onPcmFrame?: (frame: Buffer) => void): StereoPcmMixer {
		return new StereoPcmMixer(onPcmFrame);
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

			this.bytesMixed += output.length;
			this.onPcmFrame?.(output);
			this.nextFrameToFlush += 1;
		}
	}

	close(): StereoMixerStats {
		if (this.closed) {
			return this.stats;
		}
		this.closed = true;
		clearInterval(this.timer);

		const elapsedFrames = Math.ceil((Date.now() - this.startedAt) / FRAME_DURATION_MS);
		this.flushThrough(elapsedFrames - 1);

		return this.stats;
	}

	private get stats(): StereoMixerStats {
		return {
			framesMixed: this.nextFrameToFlush,
			lateFramesDropped: this.lateFramesDropped,
			bytesMixed: this.bytesMixed,
		};
	}
}

export const stereoAudioFormat = {
	sampleRate: SAMPLE_RATE,
	channels: CHANNELS,
	frameSamples: FRAME_SAMPLES,
};
