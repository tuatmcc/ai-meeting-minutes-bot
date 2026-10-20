const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const TARGET_SAMPLE_RATE = 16_000;
const FRAME_SAMPLES = 960;
const FILTER_TAPS = 31;
const FILTER_CUTOFF = 0.15;

const FILTER = createLowPassFilter();

function createLowPassFilter(): Float64Array {
	const filter = new Float64Array(FILTER_TAPS);
	const center = (FILTER_TAPS - 1) / 2;
	let sum = 0;

	for (let tap = 0; tap < FILTER_TAPS; tap += 1) {
		const distance = tap - center;
		const sinc = distance === 0 ? 1 : Math.sin(2 * Math.PI * FILTER_CUTOFF * distance) / (2 * Math.PI * FILTER_CUTOFF * distance);
		const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * tap) / (FILTER_TAPS - 1));
		const coefficient = 2 * FILTER_CUTOFF * sinc * window;
		filter[tap] = coefficient;
		sum += coefficient;
	}

	for (let tap = 0; tap < FILTER_TAPS; tap += 1) {
		filter[tap] /= sum;
	}

	return filter;
}

export class StreamAudioEncoder {
	private readonly history = new Float64Array(FILTER_TAPS);
	private historyIndex = 0;
	private inputSampleIndex = 0;

	encode48kStereoPcm16le(frame: Buffer): Buffer {
		const frameBytes = FRAME_SAMPLES * CHANNELS * 2;
		if (frame.length !== frameBytes) {
			throw new Error(`Expected a ${frameBytes}-byte 48kHz stereo PCM frame`);
		}

		const output = Buffer.allocUnsafe((FRAME_SAMPLES / (SAMPLE_RATE / TARGET_SAMPLE_RATE)) * 4);
		let outputOffset = 0;

		for (let sample = 0; sample < FRAME_SAMPLES; sample += 1) {
			const inputOffset = sample * CHANNELS * 2;
			const mono = (frame.readInt16LE(inputOffset) + frame.readInt16LE(inputOffset + 2)) / 65_536;
			this.history[this.historyIndex] = mono;

			if (this.inputSampleIndex % (SAMPLE_RATE / TARGET_SAMPLE_RATE) === SAMPLE_RATE / TARGET_SAMPLE_RATE - 1) {
				let filtered = 0;
				for (let tap = 0; tap < FILTER_TAPS; tap += 1) {
					const historyIndex = (this.historyIndex - tap + FILTER_TAPS) % FILTER_TAPS;
					filtered += FILTER[tap] * this.history[historyIndex];
				}
				output.writeFloatLE(Math.max(-1, Math.min(1, filtered)), outputOffset);
				outputOffset += 4;
			}

			this.historyIndex = (this.historyIndex + 1) % FILTER_TAPS;
			this.inputSampleIndex += 1;
		}

		return output.subarray(0, outputOffset);
	}
}
