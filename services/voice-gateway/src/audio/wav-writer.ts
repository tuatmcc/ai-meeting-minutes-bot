import { createWriteStream } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { once } from 'node:events';
import { dirname } from 'node:path';

type WavWriterOptions = {
	filePath: string;
	sampleRate: number;
	channels: number;
	bitsPerSample: number;
};

function createWavHeader(dataLength: number, { sampleRate, channels, bitsPerSample }: Omit<WavWriterOptions, 'filePath'>): Buffer {
	const bytesPerSample = bitsPerSample / 8;
	const blockAlign = channels * bytesPerSample;
	const header = Buffer.alloc(44);

	header.write('RIFF', 0, 'ascii');
	header.writeUInt32LE(36 + dataLength, 4);
	header.write('WAVE', 8, 'ascii');
	header.write('fmt ', 12, 'ascii');
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(channels, 22);
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(sampleRate * blockAlign, 28);
	header.writeUInt16LE(blockAlign, 32);
	header.writeUInt16LE(bitsPerSample, 34);
	header.write('data', 36, 'ascii');
	header.writeUInt32LE(dataLength, 40);

	return header;
}

export class WavWriter {
	private readonly stream;
	private readonly options: Omit<WavWriterOptions, 'filePath'>;
	private dataLength = 0;
	private closed = false;

	private constructor(
		private readonly filePath: string,
		options: Omit<WavWriterOptions, 'filePath'>,
	) {
		this.options = options;
		this.stream = createWriteStream(filePath, { flags: 'w' });
		this.stream.write(createWavHeader(0, options));
	}

	static async create(options: WavWriterOptions): Promise<WavWriter> {
		await mkdir(dirname(options.filePath), { recursive: true });
		return new WavWriter(options.filePath, {
			sampleRate: options.sampleRate,
			channels: options.channels,
			bitsPerSample: options.bitsPerSample,
		});
	}

	writePcm16le(pcm: Buffer): void {
		if (this.closed) {
			throw new Error('Cannot write to a closed WAV file');
		}
		if (pcm.length % 2 !== 0) {
			throw new Error('PCM16 data must contain an even number of bytes');
		}

		this.dataLength += pcm.length;
		this.stream.write(pcm);
	}

	async close(): Promise<void> {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.stream.end();
		await once(this.stream, 'close');

		const file = await open(this.filePath, 'r+');
		try {
			await file.write(createWavHeader(this.dataLength, this.options), 0, 44, 0);
		} finally {
			await file.close();
		}
	}

	get bytesWritten(): number {
		return this.dataLength;
	}
}
