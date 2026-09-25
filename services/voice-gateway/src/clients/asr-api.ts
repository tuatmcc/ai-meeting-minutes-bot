import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { AsrStream } from './asr-stream.js';

export type AsrTranscription = {
	model: string;
	language: string | null;
	text: string;
};

export class AsrApi {
	private readonly baseUrl: URL;

	constructor(asrApiUrl: string) {
		this.baseUrl = new URL(asrApiUrl.endsWith('/') ? asrApiUrl : `${asrApiUrl}/`);
	}

	openStream(onPartial?: (result: AsrTranscription) => void): Promise<AsrStream> {
		return AsrStream.connect(this.baseUrl.toString(), onPartial);
	}

	async transcribe(filePath: string): Promise<AsrTranscription> {
		const audio = await readFile(filePath);
		const form = new FormData();
		form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), basename(filePath));
		form.append('language', 'Japanese');

		const response = await fetch(new URL('transcribe', this.baseUrl), {
			method: 'POST',
			body: form,
		});
		const body: unknown = await response.json().catch(() => undefined);
		if (!response.ok) {
			throw new Error(`ASR API failed with HTTP ${response.status}`);
		}
		if (!isAsrTranscription(body)) {
			throw new Error('ASR API returned an invalid response');
		}
		return body;
	}
}

function isAsrTranscription(value: unknown): value is AsrTranscription {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const body = value as Record<string, unknown>;
	return typeof body.model === 'string' && (body.language === null || typeof body.language === 'string') && typeof body.text === 'string';
}
