import assert from 'node:assert/strict';
import test from 'node:test';
import { AsrApi } from './asr-api.ts';

const session = { guildId: '1', channelId: '2', sessionId: 'meeting' };
const metadata = { index: 7, speakerId: '123', startMs: 10, endMs: 1010 };
const result = { model: 'whisper', language: 'ja', text: 'こんにちは' };

void test('retries network failures, 429, and 5xx with identical request identity and audio', async () => {
	const requests: RequestInit[] = [];
	const delays: number[] = [];
	const request: typeof fetch = async (url, init) => {
		assert.equal(
			url instanceof URL ? url.href : typeof url === 'string' ? url : url.url,
			'https://worker.example/api/v1/guilds/1/voice-channels/2/sessions/meeting/transcribe',
		);
		requests.push(init!);
		if (requests.length === 1) throw new TypeError('network failed');
		if (requests.length === 2) return new Response('', { status: 429, headers: { 'Retry-After': '2' } });
		if (requests.length === 3) return new Response('', { status: 503 });
		return Response.json(result);
	};
	const api = new AsrApi('https://worker.example', 'token', request, async (ms) => {
		delays.push(ms);
	});
	assert.deepEqual(await api.transcribeWav(session, Buffer.from('audio'), metadata), result);
	assert.equal(requests.length, 4);
	for (const init of requests) {
		assert.deepEqual(Buffer.from(init.body as Uint8Array), Buffer.from('audio'));
		assert.equal(new Headers(init.headers).get('X-Segment-Index'), '7');
		assert.equal(new Headers(init.headers).get('X-Speaker-Id'), '123');
		assert.equal(new Headers(init.headers).get('X-Start-Ms'), '10');
		assert.equal(new Headers(init.headers).get('X-End-Ms'), '1010');
	}
	assert.deepEqual(delays, [1000, 2000, 4000]);
});

void test('retries interrupted response body with the same segment index', async () => {
	let attempts = 0;
	const request: typeof fetch = async (_url, init) => {
		assert.equal(new Headers(init!.headers).get('X-Segment-Index'), '7');
		if (++attempts === 1)
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.error(new TypeError('connection closed'));
					},
				}),
			);
		return Response.json(result);
	};
	assert.deepEqual(
		await new AsrApi('https://worker.example', 'token', request, async () => {}).transcribeWav(session, Buffer.from('audio'), metadata),
		result,
	);
	assert.equal(attempts, 2);
});

void test('does not retry permanent 4xx errors and caps retryable failures at four attempts', async () => {
	for (const status of [400, 503]) {
		let attempts = 0;
		const request: typeof fetch = async () => {
			attempts++;
			return new Response('', { status });
		};
		await assert.rejects(
			new AsrApi('https://worker.example', 'token', request, async () => {}).transcribeWav(session, Buffer.alloc(0), metadata),
			new RegExp(`HTTP ${status}`),
		);
		assert.equal(attempts, status === 400 ? 1 : 4);
	}
});
