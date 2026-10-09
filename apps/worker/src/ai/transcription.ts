import type { WorkerEnv } from '../env.js';

export const TRANSCRIPTION_MODEL = '@cf/openai/whisper-large-v3-turbo';
export const MAX_AUDIO_BYTES = 60 * 16_000 * 2 + 44;

export type AudioSegmentMetadata = {
	index: number;
	speakerId: string;
	startMs: number;
	endMs: number;
};

export type Transcription = { model: string; language: string | null; text: string };
export type TranscriptionOperation =
	| { ok: true; transcription: Transcription }
	| { ok: false; code: 'SESSION_NOT_FOUND' | 'INVALID_SESSION_STATE' | 'SEGMENT_CONFLICT' | 'TRANSCRIPTION_FAILED' };

export function parseSegmentMetadata(headers: Headers): AudioSegmentMetadata | null {
	const integer = (name: string): number => {
		const value = headers.get(name) ?? '';
		return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : -1;
	};
	const index = integer('X-Segment-Index');
	const startMs = integer('X-Start-Ms');
	const endMs = integer('X-End-Ms');
	const speakerId = headers.get('X-Speaker-Id') ?? '';
	return index >= 0 && startMs >= 0 && endMs > startMs && endMs - startMs <= 60_000 && /^\d{17,20}$/.test(speakerId)
		? { index, speakerId, startMs, endMs }
		: null;
}

export async function readAudio(request: Request): Promise<ArrayBuffer | null> {
	if (request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'audio/wav' || !request.body) {
		return null;
	}
	const length = request.headers.get('Content-Length');
	if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_AUDIO_BYTES)) {
		return null;
	}
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_AUDIO_BYTES) {
				await reader.cancel();
				return null;
			}
			chunks.push(value);
		}
	} catch {
		return null;
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes.buffer;
}

// The gateway emits canonical 44-byte WAV headers with PCM16 mono at 16 kHz.
export function isValidAudio(audio: ArrayBuffer, metadata: AudioSegmentMetadata): boolean {
	if (audio.byteLength <= 44 || audio.byteLength > MAX_AUDIO_BYTES || audio.byteLength % 2 !== 0) return false;
	const view = new DataView(audio);
	const tag = (offset: number) => String.fromCharCode(...new Uint8Array(audio, offset, 4));
	const dataSize = audio.byteLength - 44;
	return (
		tag(0) === 'RIFF' &&
		view.getUint32(4, true) === audio.byteLength - 8 &&
		tag(8) === 'WAVE' &&
		tag(12) === 'fmt ' &&
		view.getUint32(16, true) === 16 &&
		view.getUint16(20, true) === 1 &&
		view.getUint16(22, true) === 1 &&
		view.getUint32(24, true) === 16_000 &&
		view.getUint32(28, true) === 32_000 &&
		view.getUint16(32, true) === 2 &&
		view.getUint16(34, true) === 16 &&
		tag(36) === 'data' &&
		view.getUint32(40, true) === dataSize &&
		Math.abs(dataSize / 32 - (metadata.endMs - metadata.startMs)) <= 1
	);
}

export async function transcribeAudio(env: WorkerEnv, audio: ArrayBuffer): Promise<Transcription> {
	const bytes = new Uint8Array(audio);
	const parts: string[] = [];
	for (let offset = 0; offset < bytes.length; offset += 8192) {
		parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
	}
	const output = await env.AI.run(TRANSCRIPTION_MODEL, {
		audio: btoa(parts.join('')),
		task: 'transcribe',
		language: 'ja',
		initial_prompt: 'MCC, Cloudflare, Workers AI, Notion, Discord, Durable Objects',
		vad_filter: true,
		condition_on_previous_text: false,
	});
	if (typeof output.text !== 'string') throw new Error('Workers AI returned an invalid transcription');
	return { model: TRANSCRIPTION_MODEL, language: output.transcription_info?.language ?? null, text: output.text.trim() };
}
